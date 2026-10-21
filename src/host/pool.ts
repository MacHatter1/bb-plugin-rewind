// Host-local, Rewind-owned objects. Workspaces keep their own indexes/refs and
// write new objects locally. Only this coordinator changes pool reachability.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { GC_TIMEOUT_MS } from "../constants";
import { absolutePathSchema } from "../host-contract";
import { runGit, type GitRunOptions } from "./git";
import { atomicWrite, optionalText, pooledRepository, poolPaths, syncDirectory, withPoolRead, withPoolWrite } from "./pool-coordination";
import { directorySize, Shadow, shadowKey, shadowsRoot } from "./shadow";

const keySchema = z.string().regex(/^[0-9a-f]{32}$/u);
const memberSchema = z.object({ version: z.literal(1), key: keySchema, phase: z.enum(["copying", "linked", "ready"]) }).strict();
type Member = z.infer<typeof memberSchema>;
const sha = /^[0-9a-f]{40}$/u;
const ROOTS = "refs/rewind-pool/members/";
const RETIRED = "refs/rewind-pool/retired/";
const GRACE_MS = 2 * 60 * 60 * 1000;

export interface PoolResult {
  stores: number;
  migrated: number;
  members: number;
  gcRan: boolean;
  beforeBytes: number | null;
  afterBytes: number | null;
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe Rewind directory: ${file}`);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function directoryNames(file: string): Promise<string[]> {
  if (!(await isDirectory(file))) return [];
  return readdir(file); // Permission/I/O failures must stop GC, never mean "empty".
}

export class ObjectPool {
  readonly paths;
  constructor(readonly dataDir: string, private readonly signal?: AbortSignal, private readonly now: () => number = Date.now) {
    if (/[\r\n\0]/u.test(dataDir)) throw new Error("Rewind's pool path cannot contain line breaks or NUL.");
    this.paths = poolPaths(dataDir);
  }

  private git(args: readonly string[], options: Partial<GitRunOptions> = {}) {
    return runGit([`--git-dir=${this.paths.git}`, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.logAllRefUpdates=false", "-c", "core.hooksPath=", "-c", "core.fsync=all", ...args], {
      cwd: this.paths.root, signal: this.signal, timeoutMs: GC_TIMEOUT_MS,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull }, ...options,
    });
  }

  private async ensure(): Promise<void> {
    if (!(await isDirectory(this.paths.root))) await mkdir(this.paths.root, { recursive: true });
    const marker = await optionalText(this.paths.marker);
    if (marker === null) {
      if (await isDirectory(this.paths.git)) throw new Error("Unrecognized Git repository in Rewind's pool; leaving it untouched.");
      await atomicWrite(this.paths.marker, JSON.stringify({ version: 1 }));
    } else if (JSON.parse(marker).version !== 1) throw new Error("Unsupported Rewind object-pool version.");
    await mkdir(this.paths.members, { recursive: true });
    // Reinitialization is idempotent and also completes an interrupted first
    // init. The ownership marker was validated before touching this directory.
    await isDirectory(this.paths.git); // Reject a symlink/non-directory first.
    await runGit(["-c", "init.defaultObjectFormat=sha1", "-c", "init.defaultRefFormat=files", "init", "--bare", "--quiet", "--template=", this.paths.git], { cwd: this.paths.root, signal: this.signal });
    if (!(await isDirectory(this.paths.objects))) throw new Error("Rewind's pool object directory is missing.");
    if (await optionalText(path.join(this.paths.objects, "info", "alternates")) !== null) throw new Error("Rewind's pool cannot borrow another repository's objects.");
    await this.git(["config", "gc.auto", "0"]);
    await this.git(["config", "maintenance.auto", "false"]);
  }

  private async members(): Promise<Member[]> {
    const members: Member[] = [];
    for (const name of await directoryNames(this.paths.members)) {
      if (name.endsWith(".tmp")) continue;
      if (!/^[0-9a-f]{32}\.json$/u.test(name)) throw new Error(`Unknown Rewind pool member file: ${name}`);
      const text = await optionalText(path.join(this.paths.members, name));
      const member = memberSchema.parse(JSON.parse(text ?? "null"));
      if (`${member.key}.json` !== name) throw new Error("Rewind pool member identity mismatch.");
      members.push(member);
    }
    return members;
  }

  private async journal(shadow: Shadow, phase: Member["phase"]): Promise<void> {
    await atomicWrite(path.join(this.paths.members, `${shadow.key}.json`), JSON.stringify({ version: 1, key: shadow.key, phase } satisfies Member));
  }

  private async shadow(key: string): Promise<Shadow> {
    keySchema.parse(key);
    const root = path.join(shadowsRoot(this.dataDir), key);
    if (!(await isDirectory(root)) || !(await isDirectory(path.join(root, "git")))) throw new Error(`Rewind store ${key} is incomplete; retaining pool data.`);
    const state = JSON.parse(await optionalText(path.join(root, "state.json")) ?? "null") as { workspace?: unknown } | null;
    const workspace = absolutePathSchema.parse(state?.workspace);
    if (shadowKey(workspace) !== key) throw new Error(`Rewind store ${key} has invalid workspace metadata; retaining pool data.`);
    const shadow = new Shadow(this.dataDir, workspace, this.now, this.signal);
    if (!(await shadow.exists()) || await shadow.loadState() === null) throw new Error(`Rewind store ${key} has unreadable state; retaining pool data.`);
    return shadow;
  }

  private async selected(workspaces: readonly string[] | null): Promise<Shadow[]> {
    const keys = workspaces === null
      ? (await directoryNames(shadowsRoot(this.dataDir))).filter(name => /^[0-9a-f]{16,64}$/u.test(name))
      : [...new Set(workspaces.map(workspace => shadowKey(workspace)))];
    const out: Shadow[] = [];
    for (const key of keys) out.push(await this.shadow(key));
    return out;
  }

  private async size(shadows: readonly Shadow[]): Promise<number | null> {
    const pool = await directorySize(this.paths.root);
    if (pool === null) return null;
    let total = pool;
    for (const shadow of shadows) {
      const bytes = await directorySize(shadow.root);
      if (bytes === null) return null;
      total += bytes;
    }
    return total;
  }

  /** Atomic, durable copies; never move/link objects out of a participant. */
  private async copyObjects(shadow: Shadow): Promise<void> {
    const source = path.join(shadow.gitDir, "objects");
    if (!(await isDirectory(source))) throw new Error("Missing participant objects; retaining local storage.");
    for (const directory of await directoryNames(source)) {
      if (directory !== "pack" && !/^[0-9a-f]{2}$/u.test(directory)) continue;
      const fromDir = path.join(source, directory), toDir = path.join(this.paths.objects, directory);
      if (!(await isDirectory(toDir))) await mkdir(toDir, { recursive: true });
      const names = await directoryNames(fromDir);
      // Install .pack before its .idx. Git reads only complete, indexed packs.
      names.sort((a, b) => Number(a.endsWith(".idx")) - Number(b.endsWith(".idx")));
      for (const name of names) {
        this.signal?.throwIfAborted();
        if (directory === "pack" ? !/^pack-[0-9a-f]{40}\.(pack|idx|rev|mtimes)$/u.test(name) : !/^[0-9a-f]{38}$/u.test(name)) continue;
        const sourceFile = path.join(fromDir, name), target = path.join(toDir, name);
        const info = await lstat(sourceFile);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe participant object: ${sourceFile}`);
        try {
          const existing = await lstat(target);
          if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Unsafe pool object: ${target}`);
          continue; // Object IDs/pack checksums are verified before local cleanup.
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const temp = path.join(toDir, `tmp-rewind-${randomUUID()}`);
        try {
          await copyFile(sourceFile, temp, constants.COPYFILE_FICLONE);
          const handle = await open(temp, "r");
          try { await handle.sync(); } finally { await handle.close(); }
          await rename(temp, target);
        } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
      }
      await syncDirectory(toDir);
    }
    await syncDirectory(this.paths.objects);
  }

  private async inventory(shadow: Shadow): Promise<Map<string, string>> {
    const roots = new Map<string, string>();
    const prefix = `${ROOTS}${shadow.key}/`;
    const output = (await shadow.bare(["for-each-ref", "--format=%(objectname) %(refname)"])).stdout.toString("utf8").trim();
    for (const line of output ? output.split("\n") : []) {
      const [oid, ref] = line.split(" ");
      if (!sha.test(oid ?? "") || !ref?.startsWith("refs/")) throw new Error("Invalid participant ref inventory; retaining pool data.");
      roots.set(`${prefix}${ref}`, oid!);
    }
    // The persistent index and deduplication cache can outlive checkpoint refs.
    const index = await optionalText(path.join(shadow.root, "state.json"));
    if (index === null) throw new Error("Participant state disappeared; retaining pool data.");
    const state = JSON.parse(index) as { lastTree?: unknown; lastCommit?: unknown };
    for (const field of ["lastTree", "lastCommit"] as const) {
      const value = state[field];
      if (value === null || value === undefined) continue;
      if (typeof value !== "string" || !sha.test(value)) throw new Error("Invalid participant cache root; retaining pool data.");
      roots.set(`${prefix}${field}`, value);
    }
    try {
      const info = await lstat(path.join(shadow.gitDir, "index"));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe participant index; retaining pool data.");
      const tree = (await shadow.bare(["write-tree"])).stdout.toString("utf8").trim();
      if (!sha.test(tree)) throw new Error("Invalid participant index root.");
      roots.set(`${prefix}index`, tree);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const head = (await optionalText(path.join(shadow.gitDir, "HEAD")))?.trim();
    if (head !== undefined && sha.test(head)) roots.set(`${prefix}HEAD`, head);
    return roots;
  }

  private async refs(): Promise<Map<string, string>> {
    const out = (await this.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/rewind-pool/"])).stdout.toString("utf8").trim();
    return new Map((out ? out.split("\n") : []).map(line => { const [oid, ref] = line.split(" "); return [ref!, oid!]; }));
  }

  private async replaceRoots(roots: Map<string, string>, selected: ReadonlySet<string> | null, expire: boolean): Promise<void> {
    const previous = await this.refs();
    const next = new Map(previous);
    for (const [ref, oid] of previous) {
      if (ref.startsWith(ROOTS) && (selected === null || selected.has(ref.slice(ROOTS.length).split("/")[0]!))) {
        if (roots.get(ref) !== oid) next.set(`${RETIRED}${this.now()}-${randomUUID()}/${oid}`, oid);
        next.delete(ref);
      }
      if (expire && ref.startsWith(RETIRED)) {
        const time = Number(ref.slice(RETIRED.length).split("-")[0]);
        if (!Number.isFinite(time)) throw new Error("Unreadable retired-root age; retaining pool data.");
        if (time + GRACE_MS <= this.now()) next.delete(ref);
      }
    }
    for (const [ref, oid] of roots) next.set(ref, oid);
    const commands = ["start"];
    for (const [ref, oid] of previous) if (!next.has(ref)) commands.push(`delete ${ref} ${oid}`);
    for (const [ref, oid] of next) if (previous.get(ref) !== oid) commands.push(`update ${ref} ${oid} ${previous.get(ref) ?? "0".repeat(40)}`);
    commands.push("prepare", "commit", "");
    await this.git(["update-ref", "--stdin"], { input: commands.join("\n") });
  }

  private async cleanLocal(shadow: Shadow): Promise<void> {
    await shadow.bare(["repack", "-a", "-d", "--local", "--keep-unreachable", "--quiet", "--threads=2", "--window=10", "--window-memory=64m"], { timeoutMs: GC_TIMEOUT_MS });
    await shadow.bare(["prune-packed", "--quiet"]);
    await this.verifyMember(shadow);
  }

  private async verifyMember(shadow: Shadow): Promise<void> {
    // Full pool fsck already checks every stored byte. Walk each member's
    // complete ref closure without re-reading the entire host pool per member.
    await shadow.bare(["rev-list", "--objects", "--all", "--missing=error", "--no-object-names"], { timeoutMs: GC_TIMEOUT_MS });
  }

  async migrate(workspaces: readonly string[] | null, dryRun: boolean): Promise<PoolResult> {
    const run = async (): Promise<PoolResult> => {
      const shadows = await this.selected(workspaces);
      const beforeBytes = await this.size(shadows);
      const prior = await this.members();
      if (dryRun || shadows.length === 0) return { stores: shadows.length, migrated: 0, members: prior.length, gcRan: false, beforeBytes, afterBytes: beforeBytes };
      // A missing pool must not be silently replaced by a fresh empty one.
      for (const shadow of shadows) await pooledRepository(this.dataDir, shadow.gitDir);
      await this.ensure();
      const roots = new Map<string, string>();
      const inventories = new Map<Shadow, string[]>();
      for (const shadow of shadows) {
        const linked = await pooledRepository(this.dataDir, shadow.gitDir);
        if (linked) await this.verifyMember(shadow);
        else await shadow.bare(["fsck", "--full", "--no-dangling"], { timeoutMs: GC_TIMEOUT_MS });
        if (!linked) {
          const oids = (await shadow.bare(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).stdout.toString("utf8").trim();
          inventories.set(shadow, oids ? oids.split("\n") : []);
        }
        await this.journal(shadow, "copying");
        const memberRoots = await this.inventory(shadow); // write-tree may create objects, so copy afterward.
        await this.copyObjects(shadow);
        for (const [ref, oid] of memberRoots) roots.set(ref, oid);
      }
      await this.replaceRoots(roots, new Set(shadows.map(s => s.key)), false);
      await this.git(["fsck", "--full", "--no-dangling"]);
      await this.git(["-c", "pack.compression=9", "repack", "-a", "-d", "--keep-unreachable", "--quiet", "--threads=2", "--window=10", "--window-memory=64m"]);
      await this.git(["fsck", "--full", "--no-dangling"]);
      const objects = new Set((await this.git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).stdout.toString("utf8").trim().split("\n"));
      for (const oids of inventories.values()) for (const oid of oids) if (!objects.has(oid)) throw new Error(`Pool verification failed for ${oid}; local objects were retained.`);
      let migrated = 0;
      for (const shadow of shadows) {
        // A failed/aborted cleanup leaves both a readable pool and a resumable journal.
        await atomicWrite(path.join(shadow.gitDir, "objects", "info", "alternates"), `${this.paths.objects.replaceAll("\\", "/")}\n`);
        await this.journal(shadow, "linked");
        await this.verifyMember(shadow);
        await this.cleanLocal(shadow);
        await this.journal(shadow, "ready");
        if (!prior.some(member => member.key === shadow.key && member.phase === "ready")) migrated++;
      }
      return { stores: shadows.length, migrated, members: (await this.members()).length, gcRan: false, beforeBytes, afterBytes: await this.size(shadows) };
    };
    return dryRun ? withPoolRead(this.dataDir, run, this.signal) : withPoolWrite(this.dataDir, "migrate", run, this.signal);
  }

  async gc(dryRun: boolean): Promise<PoolResult> {
    const run = async (): Promise<PoolResult> => {
      const marker = await optionalText(this.paths.marker);
      if (marker === null) {
        for (const key of await directoryNames(shadowsRoot(this.dataDir))) {
          if (!/^[0-9a-f]{16,64}$/u.test(key)) continue;
          if (await optionalText(path.join(shadowsRoot(this.dataDir), key, "git", "objects", "info", "alternates")) !== null) throw new Error("Rewind's shared object pool is unavailable; retaining participant data.");
        }
        return { stores: 0, migrated: 0, members: 0, gcRan: false, beforeBytes: 0, afterBytes: 0 };
      }
      if (JSON.parse(marker).version !== 1) throw new Error("Unsupported Rewind pool; retaining objects.");
      const members = await this.members();
      if (!(await isDirectory(this.paths.root)) || !(await isDirectory(this.paths.git)) || !(await isDirectory(this.paths.objects))) throw new Error("Rewind's pool is incomplete; retaining data.");
      if (await optionalText(path.join(this.paths.objects, "info", "alternates")) !== null) throw new Error("Rewind's pool cannot borrow objects; retaining data.");
      const keys = new Set(members.map(m => m.key));
      const shadows: Shadow[] = [], removed: Member[] = [];
      // Discover every shadow as well as the registry: an unregistered borrower
      // is uncertainty, not permission to collect its objects.
      for (const key of await directoryNames(shadowsRoot(this.dataDir))) {
        if (!/^[0-9a-f]{16,64}$/u.test(key)) continue;
        const alt = await optionalText(path.join(shadowsRoot(this.dataDir), key, "git", "objects", "info", "alternates"));
        if (alt !== null && !keys.has(key)) throw new Error(`Unregistered pool borrower ${key}; retaining all pool data.`);
      }
      for (const member of members) {
        if (member.phase !== "ready") throw new Error(`Pool migration for ${member.key} is incomplete. Rerun pool migration before GC; objects were retained.`);
        if (!(await isDirectory(path.join(shadowsRoot(this.dataDir), member.key)))) { removed.push(member); continue; }
        const shadow = await this.shadow(member.key);
        if (!(await pooledRepository(this.dataDir, shadow.gitDir))) throw new Error("Pool membership/link mismatch; retaining objects.");
        shadows.push(shadow);
      }
      const beforeBytes = await this.size(shadows);
      if (dryRun) return { stores: shadows.length, migrated: 0, members: members.length, gcRan: false, beforeBytes, afterBytes: beforeBytes };
      const roots = new Map<string, string>();
      for (const shadow of shadows) {
        await this.verifyMember(shadow);
        for (const [ref, oid] of await this.inventory(shadow)) roots.set(ref, oid);
        await this.copyObjects(shadow);
      }
      await this.replaceRoots(roots, null, true);
      await this.git(["fsck", "--full", "--no-dangling"]);
      // Duplicate local objects are removed only after all participant roots
      // and their dependencies are present in the pool.
      for (const shadow of shadows) await this.cleanLocal(shadow);
      await this.git(["-c", "pack.compression=9", "-c", "pack.threads=2", "-c", "pack.windowMemory=64m", "gc", "--cruft", "--quiet", "--prune=2.hours.ago"]);
      await this.git(["fsck", "--full", "--no-dangling"]);
      for (const shadow of shadows) await this.verifyMember(shadow);
      for (const member of removed) await unlink(path.join(this.paths.members, `${member.key}.json`));
      return { stores: shadows.length, migrated: 0, members: shadows.length, gcRan: true, beforeBytes, afterBytes: await this.size(shadows) };
    };
    return dryRun ? withPoolRead(this.dataDir, run, this.signal) : withPoolWrite(this.dataDir, "gc", run, this.signal);
  }
}
