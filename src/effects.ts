// Which shell commands reach outside the workspace, where restoring files
// cannot undo them: pushes, publishes, database and deploy tools, containers,
// global installs, writes elsewhere on disk, and mutating HTTP requests.
//
// Pure. A small shell-aware scanner splits a command line into simple
// commands (quotes, escapes, comments, heredocs, `&&`/`;`/`|`, and command
// substitutions), and rule tables match each one. Precision beats recall: a
// warning shown for an `echo "git push"` would teach users to ignore it.

export type EffectKind =
  | "git-push"
  | "publish"
  | "database"
  | "deploy"
  | "container"
  | "global-install"
  | "outside-write"
  | "http-mutation";

export interface ExternalEffect {
  kind: EffectKind;
  /** Short name shown in the UI, e.g. "git push", "npm publish", "rm outside the workspace". */
  label: string;
  /** The simple command that matched, whitespace-collapsed, at most 120 characters. */
  command: string;
}

export interface EffectContext {
  /** Absolute workspace path (POSIX or Windows), or null if unknown. */
  workspace: string | null;
  /** The command's working directory; null or "" means the workspace. */
  cwd: string | null;
}

// ------------------------------------------------------------- scanning

interface Word {
  /** The word with quotes removed; expansions kept as written ("$HOME/x"). */
  text: string;
  /** Contains a command substitution, so its value is unknown. */
  dynamic: boolean;
}

interface SimpleCommand {
  words: Word[];
  /** Targets of output redirections (`>`, `>>`, `&>`, `2>`). */
  outputs: Word[];
  raw: string;
}

const MAX_SCRIPT_CHARS = 64 * 1024;
const MAX_DEPTH = 4;
/** Characters a backslash escapes outside quotes. */
const SPECIAL = new Set([..." \t'\"\\$`|&;()<>#*?[]{}~!"]);

/** Split a script into simple commands. Heredoc bodies are data and skipped. */
function scan(script: string, depth = 0): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const text = script.length > MAX_SCRIPT_CHARS ? script.slice(0, MAX_SCRIPT_CHARS) : script;
  let words: Word[] = [];
  let outputs: Word[] = [];
  let start = 0;
  let current: Word | null = null;
  let redirect: "output" | "input" | null = null;
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

  const endWord = () => {
    if (current === null) return;
    if (redirect === "output") outputs.push(current);
    else if (redirect === null) words.push(current);
    redirect = null;
    current = null;
  };
  const endCommand = (end: number) => {
    endWord();
    if (words.length > 0 || outputs.length > 0) {
      commands.push({ words, outputs, raw: text.slice(start, end) });
    }
    words = [];
    outputs = [];
    redirect = null;
  };
  const append = (chars: string) => {
    current ??= { text: "", dynamic: false };
    current.text += chars;
  };
  /** Index of the `)` that closes a `$(` opened at `open`, respecting quotes. */
  const closing = (open: number): number => {
    let level = 1;
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\") index += 1;
      else if (char === "'") index = Math.max(index, text.indexOf("'", index + 1));
      else if (char === "(") level += 1;
      else if (char === ")" && --level === 0) return index;
    }
    return text.length;
  };
  const substitute = (inner: string) => {
    if (depth < MAX_DEPTH) commands.push(...scan(inner, depth + 1));
    current ??= { text: "", dynamic: false };
    current.dynamic = true;
    current.text += "$(…)";
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "\\") {
      // Only shell-special characters are escaped; `C:\Users\…` keeps its backslashes.
      if (next === "\n") index += 2;
      else if (next !== undefined && SPECIAL.has(next)) {
        append(next);
        index += 2;
      } else {
        append(char);
        index += 1;
      }
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      append(text.slice(index + 1, end === -1 ? text.length : end));
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '"') {
      current ??= { text: "", dynamic: false };
      index += 1;
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]!;
        if (inner === "\\" && index + 1 < text.length && '"\\$`\n'.includes(text[index + 1]!)) {
          if (text[index + 1] !== "\n") current.text += text[index + 1];
          index += 2;
        } else if (inner === "$" && text[index + 1] === "(") {
          const end = closing(index + 2);
          substitute(text.slice(index + 2, end));
          index = end + 1;
        } else if (inner === "`") {
          const end = text.indexOf("`", index + 1);
          substitute(text.slice(index + 1, end === -1 ? text.length : end));
          index = end === -1 ? text.length : end + 1;
        } else {
          current.text += inner;
          index += 1;
        }
      }
      index += 1;
      continue;
    }
    if (char === "$" && next === "(") {
      const end = closing(index + 2);
      substitute(text.slice(index + 2, end));
      index = end + 1;
      continue;
    }
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      substitute(text.slice(index + 1, end === -1 ? text.length : end));
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "#" && current === null) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "\n") {
      endCommand(index);
      index += 1;
      // Heredoc bodies start on the next line and end at their delimiter.
      for (const heredoc of heredocs.splice(0)) {
        while (index < text.length) {
          const end = text.indexOf("\n", index);
          const line = text.slice(index, end === -1 ? text.length : end);
          index = end === -1 ? text.length : end + 1;
          if ((heredoc.stripTabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) break;
        }
      }
      start = index;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      if (char === "&" && next === ">") {
        // &> and &>> redirect both streams.
        endWord();
        redirect = "output";
        index += next === ">" && text[index + 2] === ">" ? 3 : 2;
        continue;
      }
      endCommand(index);
      index += (char === "&" || char === "|" || char === ";") && next === char ? 2 : 1;
      start = index;
      continue;
    }
    if (char === ">" || char === "<") {
      // A digit-only word right before the operator is its file descriptor.
      if (current !== null && /^\d$/u.test(current.text) && !current.dynamic) current = null;
      else endWord();
      if (char === "<" && next === "<" && text[index + 2] === "<") {
        redirect = "input";
        index += 3;
      } else if (char === "<" && next === "<") {
        const stripTabs = text[index + 2] === "-";
        index += stripTabs ? 3 : 2;
        while (text[index] === " " || text[index] === "\t") index += 1;
        const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/u.exec(text.slice(index));
        if (match !== null) {
          heredocs.push({ delimiter: match[2]!, stripTabs });
          index += match[0].length;
        }
      } else if (char === ">" && next === "&") {
        // 2>&1: a descriptor, not a file.
        index += 2;
        while (index < text.length && /[\d-]/u.test(text[index]!)) index += 1;
      } else {
        redirect = char === ">" ? "output" : "input";
        index += char === ">" && (next === ">" || next === "|") ? 2 : 1;
      }
      continue;
    }
    append(char);
    index += 1;
  }
  endCommand(text.length);
  return commands;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * If the command is a shell wrapper like `/bin/zsh -lc "…"` or `bash -c '…'`,
 * the inner script (unescaped); otherwise the command itself.
 */
export function unwrapShell(command: string): string {
  let script = command;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const [first] = scan(script);
    if (first === undefined) return script;
    const words = first.words.map((word) => word.text);
    let at = words[0] === "env" || basename(words[0] ?? "") === "env" ? 1 : 0;
    if (!SHELLS.has(basename(words[at] ?? ""))) return script;
    at += 1;
    while (at < words.length && words[at]!.startsWith("-") && !/^-[a-z]*c[a-z]*$/u.test(words[at]!)) at += 1;
    if (!/^-[a-z]*c[a-z]*$/u.test(words[at] ?? "") || words[at + 1] === undefined) return script;
    // The wrapper is the whole command: nothing may follow it.
    if (scan(script).length !== 1) return script;
    script = words[at + 1]!;
  }
  return script;
}

// ------------------------------------------------------------- matching

function basename(word: string): string {
  const name = word.split(/[\\/]/u).at(-1) ?? word;
  return name.replace(/\.(exe|cmd|bat)$/iu, "").toLowerCase();
}

function collapse(raw: string): string {
  const flat = raw.replace(/\s+/gu, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

const isHelp = (args: readonly string[]) => args.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
const positionals = (args: readonly string[]) => args.filter((arg) => !arg.startsWith("-"));

/** Runners that execute another program: skip to it. `sudo` is remembered. */
function unwrapRunner(words: string[]): { words: string[]; sudo: boolean } {
  let rest = [...words];
  let sudo = false;
  for (let guard = 0; guard < 8; guard += 1) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0]!)) rest.shift();
    const name = basename(rest[0] ?? "");
    const skipOptions = (from: number, withValue: readonly string[] = []) => {
      let at = from;
      while (at < rest.length && rest[at]!.startsWith("-")) at += withValue.includes(rest[at]!) ? 2 : 1;
      if (rest[at] === "--") at += 1;
      return rest.slice(at);
    };
    if (name === "sudo" || name === "doas") {
      sudo = true;
      rest = skipOptions(1, ["-u", "-g", "-U", "-C", "-D", "-h", "-p", "-r", "-t"]);
    } else if (name === "env") {
      rest = skipOptions(1, ["-u", "-C", "-S"]);
    } else if (name === "time" || name === "nohup" || name === "command" || name === "exec" || name === "caffeinate" || name === "stdbuf") {
      rest = skipOptions(1);
    } else if (name === "nice" || name === "ionice") {
      rest = skipOptions(1, ["-n", "-c"]);
    } else if (name === "timeout") {
      rest = skipOptions(1, ["-s", "-k"]).slice(1);
    } else if (name === "xargs") {
      rest = skipOptions(1, ["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a"]);
    } else if (name === "npx" || name === "bunx" || name === "uvx") {
      rest = skipOptions(1, ["-p", "--package", "--from", "--with"]);
    } else if ((name === "pnpm" || name === "yarn") && (rest[1] === "dlx" || rest[1] === "exec")) {
      rest = skipOptions(2);
    } else if (name === "npm" && (rest[1] === "exec" || rest[1] === "x")) {
      rest = skipOptions(2, ["-p", "--package"]);
    } else if (name === "pipx" && rest[1] === "run") {
      rest = skipOptions(2);
    } else if (/^python[0-9.]*$/u.test(name) && rest[1] === "-m" && rest[2] !== undefined) {
      rest = rest.slice(2);
    } else {
      return { words: rest, sudo };
    }
  }
  return { words: rest, sudo };
}

type Rule = (program: string, args: string[], sudo: boolean) => { kind: EffectKind; label: string } | null;

/** `git [global options] push …` */
const gitRule: Rule = (program, args) => {
  if (program !== "git") return null;
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-")) at += args[at] === "-C" || args[at] === "-c" ? 2 : 1;
  if (args[at] !== "push" || isHelp(args.slice(at + 1))) return null;
  return { kind: "git-push", label: "git push" };
};

/** First positional (optionally the first two) against a table of subcommands. */
function subcommand(args: readonly string[], valueOptions: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg.startsWith("-")) {
      if (valueOptions.includes(arg)) at += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const PUBLISH: Record<string, readonly string[]> = {
  npm: ["publish", "unpublish", "deprecate"],
  yarn: ["publish"],
  pnpm: ["publish"],
  bun: ["publish"],
  lerna: ["publish"],
  changeset: ["publish"],
  cargo: ["publish"],
  twine: ["upload"],
  poetry: ["publish"],
  uv: ["publish"],
  hatch: ["publish"],
  flit: ["publish"],
  gem: ["push"],
  vsce: ["publish"],
  ovsx: ["publish"],
};

const publishRule: Rule = (program, args) => {
  if (isHelp(args)) return null;
  const subs = subcommand(args, program === "pnpm" ? ["--filter", "-F"] : []);
  const first = subs[0];
  if (first !== undefined && PUBLISH[program]?.includes(first)) return { kind: "publish", label: `${program} ${first}` };
  if (program === "npm" && first === "dist-tag" && (subs[1] === "add" || subs[1] === "rm" || subs[1] === "remove")) return { kind: "publish", label: "npm dist-tag" };
  if (program === "yarn" && first === "npm" && subs[1] === "publish") return { kind: "publish", label: "yarn npm publish" };
  if (program === "dotnet" && first === "nuget" && subs[1] === "push") return { kind: "publish", label: "dotnet nuget push" };
  if (program === "mvn" && subs.includes("deploy")) return { kind: "publish", label: "mvn deploy" };
  if ((program === "gradle" || program === "gradlew") && subs.some((task) => /^:?(?:[\w-]+:)*publish/u.test(task))) return { kind: "publish", label: "gradle publish" };
  return null;
};

const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "mongosh", "mongo", "redis-cli", "sqlcmd", "cqlsh", "clickhouse-client", "dropdb", "createdb", "pg_restore", "mysqladmin"]);

const databaseRule: Rule = (program, args) => {
  if (args.includes("--help") || args.includes("--version") || args.includes("-V")) return null;
  if (DB_CLIENTS.has(program)) return { kind: "database", label: program };
  const subs = subcommand(args, ["--schema", "--config", "-c", "--env", "--knexfile", "--url", "--database-url"]);
  const [first, second] = subs;
  const db = (label: string) => ({ kind: "database" as const, label });
  switch (program) {
    case "prisma":
      if (first === "migrate" && ["dev", "deploy", "reset", "resolve"].includes(second ?? "")) return db("prisma migrate");
      if (first === "db" && ["push", "execute", "seed"].includes(second ?? "")) return db(`prisma db ${second}`);
      return null;
    case "knex":
      return first !== undefined && (first.startsWith("migrate:") || first === "seed:run") ? db(`knex ${first}`) : null;
    case "sequelize":
    case "sequelize-cli":
      return first !== undefined && /^db:(migrate|seed|drop|create)/u.test(first) ? db(`sequelize ${first}`) : null;
    case "rails":
    case "rake":
      return first !== undefined && first.startsWith("db:") ? db(`${program} ${first}`) : null;
    case "alembic":
      return ["upgrade", "downgrade", "stamp"].includes(first ?? "") ? db(`alembic ${first}`) : null;
    case "flyway":
      return ["migrate", "clean", "repair", "undo", "baseline"].includes(first ?? "") ? db(`flyway ${first}`) : null;
    case "liquibase":
      return ["update", "rollback", "dropall", "dropAll"].includes(first ?? "") ? db(`liquibase ${first}`) : null;
    case "drizzle-kit":
      return ["push", "migrate", "drop"].includes(first ?? "") ? db(`drizzle-kit ${first}`) : null;
    case "supabase":
      return first === "db" && ["push", "reset"].includes(second ?? "") ? db(`supabase db ${second}`) : null;
    case "atlas":
      return (first === "migrate" || first === "schema") && second === "apply" ? db(`atlas ${first} apply`) : null;
    case "diesel":
      if (first === "migration" && ["run", "redo", "revert"].includes(second ?? "")) return db(`diesel migration ${second}`);
      return first === "database" && ["reset", "setup", "drop"].includes(second ?? "") ? db(`diesel database ${second}`) : null;
    case "sqlx":
      if (first === "migrate" && ["run", "revert"].includes(second ?? "")) return db(`sqlx migrate ${second}`);
      return first === "database" && ["drop", "reset", "setup", "create"].includes(second ?? "") ? db(`sqlx database ${second}`) : null;
    case "goose": {
      const verb = subs.find((word) => ["up", "down", "reset", "redo", "up-to", "down-to", "up-by-one"].includes(word));
      return verb === undefined ? null : db(`goose ${verb}`);
    }
    case "dbmate":
      return ["up", "down", "drop", "rollback", "migrate"].includes(first ?? "") ? db(`dbmate ${first}`) : null;
    case "typeorm":
    case "typeorm-ts-node-commonjs":
    case "typeorm-ts-node-esm":
      return first !== undefined && /^(migration:(run|revert)|schema:(sync|drop))$/u.test(first) ? db(`typeorm ${first}`) : null;
    case "migrate": {
      const verb = subs.find((word) => ["up", "down", "drop", "force", "goto"].includes(word));
      return verb !== undefined && args.some((arg) => /^--?(database|path|source)/u.test(arg)) ? db(`migrate ${verb}`) : null;
    }
    case "manage.py":
    case "django-admin":
      return ["migrate", "flush", "loaddata"].includes(first ?? "") ? db(`manage.py ${first}`) : null;
    default:
      return null;
  }
};

const DEPLOY_WORDS: Record<string, readonly string[]> = {
  netlify: ["deploy"],
  firebase: ["deploy"],
  serverless: ["deploy", "remove"],
  sls: ["deploy", "remove"],
  cdk: ["deploy", "destroy"],
  sam: ["deploy", "delete"],
  pulumi: ["up", "destroy", "refresh", "import"],
  helm: ["install", "upgrade", "uninstall", "delete", "rollback"],
  eb: ["deploy", "terminate"],
  railway: ["up", "deploy", "down"],
  kamal: ["deploy", "rollback", "remove"],
  amplify: ["push", "publish"],
  doctl: [],
};

const AWS_MUTATING = /^(create-|delete-|put-|update-|terminate-|run-|start-|stop-|reboot-|modify-|deploy|invoke|publish|register-|deregister-|attach-|detach-|associate-|disassociate-|remove-|add-|import-|restore-|revoke-|authorize-|send-|execute-|reset-|set-)/u;
const CLOUD_MUTATING = new Set(["deploy", "create", "delete", "update", "set", "add", "remove", "patch", "resize", "start", "stop", "reset", "import", "restart", "destroy"]);

const deployRule: Rule = (program, args) => {
  if (isHelp(args)) return null;
  const subs = subcommand(args, ["--project", "--region", "--profile", "-p", "--app", "-a", "--config", "-c", "--stage", "-s", "--env", "-e", "--namespace", "-n", "--context"]);
  const [first, second, third] = subs;
  const deploy = (label: string) => ({ kind: "deploy" as const, label });
  switch (program) {
    case "vercel":
      if (first === undefined || first === "deploy") return deploy("vercel deploy");
      return ["promote", "rollback", "remove", "rm", "redeploy"].includes(first) ? deploy(`vercel ${first}`) : null;
    case "fly":
    case "flyctl":
      if (first === "deploy" || first === "scale") return deploy(`fly ${first}`);
      return first === "apps" && (second === "destroy" || second === "create") ? deploy(`fly apps ${second}`) : null;
    case "heroku":
      return first !== undefined && /^(ps:scale|config:(set|unset)|releases:rollback|pg:reset|apps:destroy|run)$/u.test(first) ? deploy(`heroku ${first}`) : null;
    case "terraform":
    case "tofu":
      if (["apply", "destroy", "import", "taint", "untaint"].includes(first ?? "")) return deploy(`${program} ${first}`);
      return first === "state" && ["rm", "mv", "push"].includes(second ?? "") ? deploy(`${program} state ${second}`) : null;
    case "wrangler":
      if (["deploy", "publish", "delete", "rollback"].includes(first ?? "")) return deploy(`wrangler ${first}`);
      if (first === "d1" && second === "execute") return deploy("wrangler d1 execute");
      if ((first === "kv" || first === "r2") && ["put", "delete"].includes(third ?? "")) return deploy(`wrangler ${first} ${second} ${third}`);
      return first === "secret" && ["put", "delete"].includes(second ?? "") ? deploy(`wrangler secret ${second}`) : null;
    case "ansible-playbook":
      return args.includes("--syntax-check") || args.includes("--list-tasks") ? null : deploy("ansible-playbook");
    case "aws": {
      if (first === "s3" && ["cp", "mv", "rm", "sync", "rb", "mb"].includes(second ?? "")) return deploy(`aws s3 ${second}`);
      return second !== undefined && AWS_MUTATING.test(second) ? deploy(`aws ${first} ${second}`) : null;
    }
    case "gcloud":
    case "az": {
      // Local CLI settings, not the cloud.
      if (first === "config" || first === "account" || first === "auth" || first === "login") return null;
      const verb = subs.findIndex((word) => CLOUD_MUTATING.has(word));
      return verb === -1 ? null : deploy(`${program} ${subs.slice(0, verb + 1).join(" ")}`);
    }
    case "doctl":
      return subs.some((word) => ["create", "delete", "update"].includes(word)) ? deploy(`doctl ${subs.slice(0, 3).join(" ")}`) : null;
    default: {
      const words = DEPLOY_WORDS[program];
      return words !== undefined && words.includes(first ?? "") ? deploy(`${program} ${first}`) : null;
    }
  }
};

const DOCKER_MUTATING = new Set([
  "run", "push", "rm", "rmi", "stop", "kill", "restart", "start", "exec", "build", "tag", "login", "logout", "pull",
  "create", "commit", "load", "import", "pause", "unpause", "update", "rename", "cp",
]);
const COMPOSE_MUTATING = new Set(["up", "down", "rm", "stop", "restart", "run", "exec", "build", "pull", "push", "start", "kill", "create", "pause", "unpause"]);
const DOCKER_MANAGEMENT: Record<string, readonly string[]> = {
  container: ["rm", "prune", "stop", "kill", "start", "restart", "run", "exec", "create"],
  image: ["rm", "prune", "push", "pull", "build", "tag", "load", "import"],
  volume: ["rm", "prune", "create"],
  network: ["rm", "prune", "create", "connect", "disconnect"],
  system: ["prune"],
  builder: ["prune"],
  buildx: ["build", "bake", "prune"],
};
const KUBECTL_MUTATING = new Set([
  "apply", "create", "delete", "patch", "replace", "scale", "edit", "exec", "cp", "label", "annotate", "set",
  "drain", "cordon", "uncordon", "taint", "expose", "run", "autoscale",
]);

const containerRule: Rule = (program, args) => {
  if (isHelp(args)) return null;
  const container = (label: string) => ({ kind: "container" as const, label });
  if (program === "docker" || program === "podman") {
    const subs = subcommand(args, ["--context", "-H", "--host", "--config", "-l", "--log-level", "-f", "--file", "-p", "--project-name"]);
    const [first, second] = subs;
    if (first === "compose") return COMPOSE_MUTATING.has(second ?? "") ? container(`${program} compose ${second}`) : null;
    if (first !== undefined && DOCKER_MANAGEMENT[first] !== undefined) {
      return DOCKER_MANAGEMENT[first]!.includes(second ?? "") ? container(`${program} ${first} ${second}`) : null;
    }
    return DOCKER_MUTATING.has(first ?? "") ? container(`${program} ${first}`) : null;
  }
  if (program === "docker-compose" || program === "podman-compose") {
    const [first] = subcommand(args, ["-f", "--file", "-p", "--project-name", "--env-file"]);
    return COMPOSE_MUTATING.has(first ?? "") ? container(`docker compose ${first}`) : null;
  }
  if (program === "kubectl" || program === "oc") {
    const [first, second] = subcommand(args, ["-n", "--namespace", "--context", "--kubeconfig", "-s", "--server", "--cluster", "--user", "-l", "-f", "-o", "-c"]);
    if (first === "rollout") return ["restart", "undo", "pause", "resume"].includes(second ?? "") ? container(`${program} rollout ${second}`) : null;
    return KUBECTL_MUTATING.has(first ?? "") ? container(`${program} ${first}`) : null;
  }
  return null;
};

const hasGlobal = (args: readonly string[]) => args.some((arg) => arg === "-g" || arg === "--global" || arg === "--location=global");

const globalInstallRule: Rule = (program, args, sudo) => {
  if (isHelp(args)) return null;
  const subs = subcommand(args);
  const [first, second] = subs;
  const install = (label: string) => ({ kind: "global-install" as const, label });
  switch (program) {
    case "npm":
      if (["install", "i", "add", "uninstall", "remove", "rm", "un", "update", "up", "upgrade", "link", "ln"].includes(first ?? "") && hasGlobal(args)) return install(`npm ${first} -g`);
      return (first === "link" || first === "ln") && subs.length === 1 ? install("npm link") : null;
    case "pnpm":
    case "bun":
      return ["add", "remove", "rm", "install", "i", "update", "up", "uninstall", "link"].includes(first ?? "") && hasGlobal(args) ? install(`${program} ${first} -g`) : null;
    case "yarn":
      return first === "global" && ["add", "remove", "upgrade"].includes(second ?? "") ? install(`yarn global ${second}`) : null;
    case "pip":
    case "pip3":
      if (first !== "install" && first !== "uninstall") return null;
      if (args.includes("--user")) return install(`pip ${first} --user`);
      if (args.includes("--break-system-packages")) return install(`pip ${first} --break-system-packages`);
      return sudo ? install(`sudo pip ${first}`) : null;
    case "pipx":
      return ["install", "uninstall", "upgrade", "reinstall", "inject"].includes(first ?? "") ? install(`pipx ${first}`) : null;
    case "uv":
      if (first === "tool" && ["install", "uninstall", "upgrade"].includes(second ?? "")) return install(`uv tool ${second}`);
      return first === "pip" && second === "install" && args.includes("--system") ? install("uv pip install --system") : null;
    case "brew":
      return ["install", "uninstall", "remove", "rm", "reinstall", "upgrade", "tap", "untap", "link", "unlink"].includes(first ?? "") ? install(`brew ${first}`) : null;
    case "apt":
    case "apt-get":
      return ["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove"].includes(first ?? "") ? install(`${program} ${first}`) : null;
    case "yum":
    case "dnf":
      return ["install", "remove", "erase", "upgrade", "update"].includes(first ?? "") ? install(`${program} ${first}`) : null;
    case "pacman":
      return args.some((arg) => /^-[SRU][a-z]*$/u.test(arg) && !/^-S[a-z]*[si]/u.test(arg)) ? install("pacman") : null;
    case "apk":
      return ["add", "del"].includes(first ?? "") ? install(`apk ${first}`) : null;
    case "zypper":
      return ["install", "in", "remove", "rm"].includes(first ?? "") ? install(`zypper ${first}`) : null;
    case "snap":
    case "port":
      return ["install", "remove", "uninstall"].includes(first ?? "") ? install(`${program} ${first}`) : null;
    case "choco":
    case "winget":
    case "scoop":
      return ["install", "uninstall", "upgrade", "update"].includes(first ?? "") ? install(`${program} ${first}`) : null;
    case "cargo":
      return first === "install" || first === "uninstall" ? install(`cargo ${first}`) : null;
    case "gem":
      return first === "install" || first === "uninstall" ? install(`gem ${first}`) : null;
    case "go":
      // `go install pkg@version` or a remote path installs into GOPATH/bin.
      if (first !== "install") return null;
      return subs.length === 1 || subs.slice(1).some((pkg) => pkg.includes("@") || /^[\w-]+\.[\w.-]+\//u.test(pkg)) ? install("go install") : null;
    case "rustup":
      if (first === "toolchain" && second === "install") return install("rustup toolchain install");
      return ["install", "default", "update"].includes(first ?? "") ? install(`rustup ${first}`) : null;
    default:
      return null;
  }
};

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const httpRule: Rule = (program, args) => {
  if (isHelp(args)) return null;
  const http = (method: string) => ({ kind: "http-mutation" as const, label: `${program} ${method}` });
  if (program === "curl") {
    let method: string | null = null;
    let data = false;
    let upload = false;
    let get = false;
    for (let at = 0; at < args.length; at += 1) {
      const arg = args[at]!;
      if (arg === "-X" || arg === "--request") method = (args[++at] ?? "").toUpperCase();
      else if (arg.startsWith("--request=")) method = arg.slice(10).toUpperCase();
      else if (/^--(data|data-raw|data-binary|data-urlencode|data-ascii|json|form|form-string)(=|$)/u.test(arg)) data = true;
      else if (arg === "--upload-file" || arg.startsWith("--upload-file=")) upload = true;
      else if (arg === "--get") get = true;
      else if (/^-[A-Za-z]/u.test(arg) && !arg.startsWith("--")) {
        // Short options cluster (-sSX POST); one that takes a value ends it.
        for (let char = 1; char < arg.length; char += 1) {
          const flag = arg[char]!;
          if (flag === "G") get = true;
          if ("XdFT".includes(flag)) {
            const value = arg.slice(char + 1) || args[++at] || "";
            if (flag === "X") method = value.toUpperCase();
            else if (flag === "T") upload = true;
            else data = true;
            break;
          }
          if ("HouAbeErwxyzmcKQ".includes(flag)) {
            if (char === arg.length - 1) at += 1;
            break;
          }
        }
      }
    }
    if (method !== null) return MUTATING_METHODS.has(method) ? http(method) : null;
    if (upload) return http("PUT");
    return data && !get ? http("POST") : null;
  }
  if (program === "http" || program === "https" || program === "xh" || program === "xhs") {
    const rest = args.filter((arg) => !arg.startsWith("-"));
    const form = args.includes("--form") || args.includes("-f");
    const explicit = rest[0]?.toUpperCase();
    if (explicit !== undefined && ["GET", "HEAD", "OPTIONS", ...MUTATING_METHODS].includes(explicit)) {
      return MUTATING_METHODS.has(explicit) ? http(explicit) : null;
    }
    // After the URL: `a=b`, `a:=1`, and `a@file` send a body (POST); `a==b` is a query.
    const items = rest.slice(1).filter((item) => /^[^=:@]+(:=|=|@)/u.test(item) && !/^[^=]+==/u.test(item));
    return items.length > 0 || form ? http("POST") : null;
  }
  if (program === "wget") {
    const method = args.find((arg) => arg.startsWith("--method="))?.slice(9).toUpperCase();
    if (method !== undefined) return MUTATING_METHODS.has(method) ? http(method) : null;
    return args.some((arg) => /^--(post-data|post-file|body-data|body-file)(=|$)/u.test(arg)) ? http("POST") : null;
  }
  return null;
};

const RULES: readonly Rule[] = [gitRule, publishRule, databaseRule, deployRule, containerRule, globalInstallRule, httpRule];

/** Package runners also run a project's tools by name: `yarn prisma migrate deploy`. */
const RUNNABLE_TOOLS = new Set(["prisma", "vercel", "knex", "sequelize", "typeorm", "drizzle-kit", "wrangler", "firebase", "netlify", "cdk", "serverless", "sls", "changeset", "lerna", "supabase", "atlas"]);

// ----------------------------------------------------- paths on disk

type Resolved = { kind: "path"; path: string; windows: boolean } | { kind: "home" } | { kind: "skip" };

const TEMP_PREFIXES = ["/dev/", "/proc/", "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/var/tmp/"];
const SYSTEM_PREFIXES = ["/etc/", "/usr/", "/opt/", "/library/", "/system/", "c:/windows/", "c:/program files/"];

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

/** Resolve `.` and `..`, unify separators, drop trailing slashes. */
function normalize(path: string, windows: boolean): string {
  const unified = windows ? path.replaceAll("\\", "/") : path;
  const prefix = windows ? (unified.startsWith("//") ? "//" : unified.slice(0, 3)) : "/";
  const parts: string[] = [];
  for (const part of unified.slice(prefix.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const joined = prefix + parts.join("/");
  return windows ? joined.toLowerCase() : joined;
}

function resolve(word: Word, cwd: string | null): Resolved {
  const text = word.text;
  if (word.dynamic || text.length === 0) return { kind: "skip" };
  if (text === "~" || text.startsWith("~/") || /^\$\{?HOME\}?(\/|$)/u.test(text)) return { kind: "home" };
  if (/^(\$\{?(TMPDIR|TMP|TEMP)\}?|%(TEMP|TMP)%)([\\/]|$)/iu.test(text)) return { kind: "skip" };
  if (text.includes("$") || text.includes("%") || text.startsWith("~")) return { kind: "skip" };
  if (text.startsWith("/")) return { kind: "path", path: normalize(text, false), windows: false };
  if (isWindowsPath(text)) return { kind: "path", path: normalize(text, true), windows: true };
  if (cwd === null) return { kind: "skip" };
  const windows = isWindowsPath(cwd);
  return { kind: "path", path: normalize(`${cwd}/${text}`, windows), windows };
}

function outside(target: Resolved, workspace: string | null): boolean {
  if (target.kind === "home") return true;
  if (target.kind !== "path") return false;
  const path = target.path;
  const lower = `${path.toLowerCase()}/`;
  if (TEMP_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  if (workspace === null) return SYSTEM_PREFIXES.some((prefix) => lower.startsWith(prefix));
  const root = normalize(workspace, isWindowsPath(workspace));
  return path !== root && !path.startsWith(`${root}/`);
}

/** Paths a file command writes or deletes, by program. */
function writtenPaths(program: string, words: Word[]): { paths: Word[]; label: string } | null {
  const args = words.slice(1);
  const operands: Word[] = [];
  let noMoreOptions = false;
  for (const arg of args) {
    if (!noMoreOptions && arg.text === "--") noMoreOptions = true;
    else if (noMoreOptions || !arg.text.startsWith("-") || arg.text === "-") operands.push(arg);
  }
  switch (program) {
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred":
      return { paths: operands, label: "rm outside the workspace" };
    case "touch":
    case "mkdir":
    case "tee":
      return { paths: operands, label: "write outside the workspace" };
    case "truncate": {
      const sized = args.some((arg) => arg.text === "-s" || arg.text === "--size") ? operands.slice(1) : operands;
      return { paths: sized, label: "write outside the workspace" };
    }
    case "chmod":
    case "chown":
    case "chgrp":
      return { paths: operands.slice(1), label: "write outside the workspace" };
    case "cp":
    case "rsync":
    case "install":
    case "ln":
    case "scp": {
      const target = args.findIndex((arg) => arg.text === "-t" || arg.text === "--target-directory");
      if (target !== -1 && args[target + 1] !== undefined) return { paths: [args[target + 1]!], label: "write outside the workspace" };
      return { paths: operands.length >= 2 ? [operands.at(-1)!] : [], label: "write outside the workspace" };
    }
    case "mv":
      return { paths: operands.length >= 2 ? operands : [], label: "move outside the workspace" };
    case "dd": {
      const out = args.find((arg) => arg.text.startsWith("of="));
      return { paths: out === undefined ? [] : [{ text: out.text.slice(3), dynamic: out.dynamic }], label: "write outside the workspace" };
    }
    case "sed":
    case "perl": {
      if (!args.some((arg) => /^-[a-zA-Z]*i/u.test(arg.text) || arg.text.startsWith("--in-place"))) return null;
      // The first operand is the script (or -f's file, or macOS's '' suffix).
      const files = operands.filter((operand) => operand.text !== "");
      return { paths: files.slice(1), label: "write outside the workspace" };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------- entry

/** Every external effect of one command string, deduplicated by label, in order. */
export function detectEffects(command: string, context: EffectContext): ExternalEffect[] {
  const effects: ExternalEffect[] = [];
  const labels = new Set<string>();
  const add = (kind: EffectKind, label: string, raw: string) => {
    if (labels.has(label)) return;
    labels.add(label);
    effects.push({ kind, label, command: collapse(raw) });
  };
  let cwd: string | null = context.cwd === null || context.cwd === "" ? context.workspace : context.cwd;

  const visit = (script: string, depth: number) => {
    for (const simple of scan(script)) {
      const unwrapped = unwrapRunner(simple.words.map((word) => word.text));
      let texts = unwrapped.words;
      // Package managers also run a project's tools: `yarn prisma …`.
      if (["yarn", "pnpm", "bun"].includes(basename(texts[0] ?? "")) && RUNNABLE_TOOLS.has(texts[1] ?? "")) texts = texts.slice(1);
      const words = simple.words.slice(simple.words.length - texts.length);
      const program = basename(texts[0] ?? "");
      const args = texts.slice(1);
      if (program === "") continue;

      // `sh -c "…"` anywhere in a script: look inside.
      if (SHELLS.has(program)) {
        const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg));
        if (flag !== -1 && args[flag + 1] !== undefined && depth < MAX_DEPTH) visit(args[flag + 1]!, depth + 1);
        continue;
      }
      if (program === "cd") {
        const target = words[1];
        if (target === undefined || target.text === "~") cwd = null;
        else {
          const resolved = resolve(target, cwd);
          cwd = resolved.kind === "path" ? resolved.path : null;
        }
        continue;
      }

      const manage = /^python[0-9.]*$/u.test(program) && basename(args[0] ?? "") === "manage.py";
      for (const rule of RULES) {
        const match = rule(manage ? "manage.py" : program, manage ? args.slice(1) : args, unwrapped.sudo);
        if (match !== null) add(match.kind, match.label, simple.raw);
      }
      const writes = writtenPaths(program, words);
      if (writes !== null && writes.paths.some((path) => outside(resolve(path, cwd), context.workspace))) {
        add("outside-write", writes.label, simple.raw);
      }
      if (simple.outputs.some((path) => outside(resolve(path, cwd), context.workspace))) {
        add("outside-write", "write outside the workspace", simple.raw);
      }
    }
  };
  visit(command, 0);
  return effects;
}
