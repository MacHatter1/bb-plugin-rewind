// The SDK has one host worker per plugin/data directory. Readers share its
// gate; pool maintenance drains them. A durable lock also stops a replacement
// worker from using stores while an orphaned maintenance process may survive.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { withReadWriteLock } from "./lock";

export function poolPaths(dataDir: string) {
  const root = path.join(dataDir, "object-pool");
  return { root, git: path.join(root, "git"), objects: path.join(root, "git", "objects"), marker: path.join(root, "pool.json"), members: path.join(root, "members"), lock: path.join(dataDir, "pool-maintenance.lock") };
}

export async function optionalText(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Unsafe Rewind metadata: ${file}`);
    return await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, file); await syncDirectory(path.dirname(file)); }
  finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

export async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose fsync on directory handles through Node.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertNoMaintenance(dataDir: string): Promise<void> {
  if (await optionalText(poolPaths(dataDir).lock) !== null) {
    throw new Error("Rewind shared-pool maintenance is locked. An interrupted worker may still own Git processes. Inspect pool-maintenance.lock and stop any orphan before clearing the lock; no shared objects were pruned by this request.");
  }
}

export function withPoolRead<T>(dataDir: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withReadWriteLock(path.resolve(dataDir), false, async () => { await assertNoMaintenance(dataDir); return fn(); }, signal);
}

export function withPoolWrite<T>(dataDir: string, operation: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withReadWriteLock(path.resolve(dataDir), true, async () => {
    await mkdir(dataDir, { recursive: true });
    const file = poolPaths(dataDir).lock;
    let handle;
    try { handle = await open(file, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") await assertNoMaintenance(dataDir); throw error; }
    try {
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, operation, startedAt: Date.now() }));
      await handle.sync();
      return await fn();
    } finally { await handle.close(); await unlink(file); }
  }, signal);
}

/** Only Rewind's exact, same-host pool may supply borrowed objects. */
export async function pooledRepository(dataDir: string, gitDir: string): Promise<boolean> {
  const paths = poolPaths(dataDir);
  for (const directory of [gitDir, path.join(gitDir, "objects"), path.join(gitDir, "objects", "info")]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Rewind repository directory: ${directory}`);
  }
  const alternate = await optionalText(path.join(gitDir, "objects", "info", "alternates"));
  const key = path.basename(path.dirname(gitDir));
  const memberText = await optionalText(path.join(paths.members, `${key}.json`));
  const member = memberText === null ? null : JSON.parse(memberText) as { version?: number; key?: string; phase?: string };
  if (alternate === null) {
    if (member?.phase === "ready" || member?.phase === "linked") throw new Error("Rewind's shared-pool link is missing; refusing to modify the store.");
    return false;
  }
  if (alternate !== `${paths.objects.replaceAll("\\", "/")}\n`) throw new Error("Unexpected Git alternates in Rewind's store; refusing shared-pool maintenance.");
  const marker = await optionalText(paths.marker);
  if (marker === null || JSON.parse(marker).version !== 1 || member?.version !== 1 || member.key !== key || !["copying", "linked", "ready"].includes(member.phase ?? "")) {
    throw new Error("Rewind's shared object pool or member journal is unavailable; refusing to modify the store.");
  }
  for (const file of [paths.root, paths.git, paths.objects]) {
    const info = await lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Rewind pool directory: ${file}`);
  }
  if (await optionalText(path.join(paths.objects, "info", "alternates")) !== null) throw new Error("Rewind's pool must not borrow objects from another repository.");
  return true;
}
