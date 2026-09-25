import { describe, expect, it } from "vitest";
import { detectEffects, unwrapShell, type EffectContext } from "../../src/effects";

const WS: EffectContext = { workspace: "/Users/me/repo", cwd: "" };
const labels = (command: string, context: EffectContext = WS) => detectEffects(command, context).map((effect) => effect.label);

function matches(command: string, label: string, context: EffectContext = WS) {
  expect(labels(command, context), command).toEqual([label]);
}
function none(command: string, context: EffectContext = WS) {
  expect(labels(command, context), command).toEqual([]);
}

describe("unwrapping shell wrappers", () => {
  it("unwraps a zsh -lc script with escapes, as Codex reports commands", () => {
    expect(unwrapShell(`/bin/zsh -lc "mkdir -p e2e && printf 'one\\\\n' > e2e/scratch.txt"`)).toBe("mkdir -p e2e && printf 'one\\n' > e2e/scratch.txt");
    expect(unwrapShell(`/bin/zsh -lc "echo \\"git push\\""`)).toBe('echo "git push"');
  });

  it("unwraps bash -c with single quotes, and nested wrappers", () => {
    expect(unwrapShell("bash -c 'npm publish --access public'")).toBe("npm publish --access public");
    expect(unwrapShell(`/usr/bin/env bash -lc "sh -c 'git push'"`)).toBe("git push");
  });

  it("leaves other commands as they are", () => {
    expect(unwrapShell("git status")).toBe("git status");
    expect(unwrapShell("bash script.sh")).toBe("bash script.sh");
  });
});

describe("git push", () => {
  it("matches every form of push, dry runs included", () => {
    matches("git push", "git push");
    matches("git push --force-with-lease origin HEAD", "git push");
    matches("git -C ../other push", "git push");
    matches("git push --dry-run /tmp/remote.git HEAD", "git push");
    matches("cd sub && git -c push.default=current push -u origin feature", "git push");
    matches('/bin/zsh -lc "git push origin main"', "git push");
  });

  it("does not match help, other subcommands, or the words in text", () => {
    none("git push --help");
    none("git help push");
    none("man git-push");
    none('echo "git push"');
    none("git log --grep=push");
    none('git commit -m "push later"');
    none("grep -r 'git push' docs/");
    none('/bin/zsh -lc "echo \\"git push\\""');
    none("# git push\ngit status");
  });

  it("ignores heredoc bodies, which are data", () => {
    none("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['echo', 'git push'])\nprint('git push')\nEOF\ngit status");
    none("cat <<-END > notes.md\n\tgit push origin main\n\tEND");
    matches("cat <<EOF > notes.md\ngit push\nEOF\ngit push", "git push");
  });

  it("looks inside command substitutions and nested shells", () => {
    matches('echo "pushed: $(git push origin HEAD 2>&1)"', "git push");
    matches("bash -c 'git push' && echo done", "git push");
  });
});

describe("package publishes", () => {
  it("matches publishing to a registry", () => {
    matches("npm publish --access public", "npm publish");
    matches("/bin/bash -c 'npm publish --access public'", "npm publish");
    matches("pnpm -r publish --no-git-checks", "pnpm publish");
    matches("yarn npm publish", "yarn npm publish");
    matches("cargo publish --dry-run", "cargo publish");
    matches("twine upload dist/*", "twine upload");
    matches("python -m twine upload dist/*", "twine upload");
    matches("gem push rewind-0.1.0.gem", "gem push");
    matches("npx changeset publish", "changeset publish");
    matches("mvn clean deploy", "mvn deploy");
    matches("./gradlew publishToMavenCentral", "gradle publish");
    matches("dotnet nuget push pkg.nupkg --source nuget.org", "dotnet nuget push");
  });

  it("does not match building or packing", () => {
    none("npm pack");
    none("npm run build");
    none("cargo build --release");
    none("mvn clean install");
    none("npm publish --help");
  });
});

describe("databases", () => {
  it("matches database clients and migrations", () => {
    matches('DATABASE_URL=postgres://x psql -c "select 1"', "psql");
    matches("mysql -u root app < dump.sql", "mysql");
    matches("npx prisma migrate deploy", "prisma migrate");
    matches("pnpm prisma db push", "prisma db push");
    matches("npx knex migrate:latest", "knex migrate:latest");
    matches("bin/rails db:migrate", "rails db:migrate");
    matches("python manage.py migrate", "manage.py migrate");
    matches("./manage.py flush --no-input", "manage.py flush");
    matches("alembic upgrade head", "alembic upgrade");
    matches("supabase db reset", "supabase db reset");
    matches("sqlx migrate run", "sqlx migrate run");
  });

  it("does not match local files or read-only tooling", () => {
    none("sqlite3 dev.db .tables");
    none("npx prisma generate");
    none("npx prisma migrate status");
    none("psql --version");
    none("alembic history");
    none("python manage.py runserver");
  });
});

describe("deploys and cloud changes", () => {
  it("matches deploys and mutating cloud commands", () => {
    matches("npx vercel --prod", "vercel deploy");
    matches("netlify deploy --prod", "netlify deploy");
    matches("fly deploy", "fly deploy");
    matches("terraform apply -auto-approve", "terraform apply");
    matches("terraform state rm aws_s3_bucket.x", "terraform state rm");
    matches("aws s3 sync ./dist s3://bucket", "aws s3 sync");
    matches("aws ec2 terminate-instances --instance-ids i-1", "aws ec2 terminate-instances");
    matches("gcloud run deploy api --region europe-west1", "gcloud run deploy");
    matches("helm upgrade --install web ./chart", "helm upgrade");
    matches("wrangler deploy", "wrangler deploy");
    matches("firebase deploy --only hosting", "firebase deploy");
    matches("ansible-playbook site.yml", "ansible-playbook");
  });

  it("does not match plans, reads, or local tooling", () => {
    none("vercel dev");
    none("vercel env ls");
    none("terraform plan");
    none("terraform init");
    none("aws s3 ls");
    none("aws ec2 describe-instances");
    none("gcloud config set project demo");
    none("helm template ./chart");
    none("wrangler dev");
    none("ansible-playbook site.yml --syntax-check");
  });
});

describe("containers", () => {
  it("matches mutating docker, podman, and kubectl commands", () => {
    matches("docker compose up -d", "docker compose up");
    matches("docker-compose down -v", "docker compose down");
    matches("docker run --rm -it node:22 bash", "docker run");
    matches("docker push ghcr.io/me/app:1", "docker push");
    matches("docker system prune -af", "docker system prune");
    matches("podman build -t app .", "podman build");
    matches("kubectl apply -f k8s/", "kubectl apply");
    matches("kubectl -n prod delete pod web-1", "kubectl delete");
    matches("kubectl rollout restart deploy/web", "kubectl rollout restart");
  });

  it("does not match reads", () => {
    none("docker ps -a");
    none("docker images");
    none("docker compose logs -f");
    none("docker compose ps");
    none("kubectl get pods");
    none("kubectl describe pod web-1");
    none("kubectl logs -f web-1");
    none("kubectl rollout status deploy/web");
    none("kubectl config view");
  });
});

describe("global installs", () => {
  it("matches installs outside the project", () => {
    matches("sudo npm i -g typescript", "npm i -g");
    matches("npm install --global pnpm", "npm install -g");
    matches("brew install jq", "brew install");
    matches("pip install --user requests", "pip install --user");
    matches("python3 -m pip install --user requests", "pip install --user");
    matches("sudo pip3 install requests", "sudo pip install");
    matches("pipx install ruff", "pipx install");
    matches("cargo install ripgrep", "cargo install");
    matches("go install golang.org/x/tools/gopls@latest", "go install");
    matches("sudo apt-get install -y jq", "apt-get install");
    matches("uv tool install ruff", "uv tool install");
  });

  it("does not match project-local installs", () => {
    none("npm install");
    none("npm i -D vitest");
    none("pnpm add zod");
    none("pip install -r requirements.txt");
    none("brew list");
    none("cargo build");
    none("go install ./cmd/tool");
    none("uv pip install -r requirements.txt");
  });
});

describe("writes outside the workspace", () => {
  it("matches deletions and writes elsewhere on disk", () => {
    matches("rm -rf /Users/me/other", "rm outside the workspace");
    matches("rm ~/notes.txt", "rm outside the workspace");
    matches("echo hi > /etc/hosts", "write outside the workspace");
    matches("cp build/app /usr/local/bin/app", "write outside the workspace");
    matches("mv config.json ../config.json", "move outside the workspace");
    matches("cd /opt && rm -rf cache", "rm outside the workspace");
    matches("tee -a $HOME/.zshrc < snippet", "write outside the workspace");
    matches("sed -i '' 's/a/b/' /etc/profile", "write outside the workspace");
    matches("cat notes >> ~/log.txt", "write outside the workspace");
  });

  it("does not match the workspace, temporary files, or paths it cannot resolve", () => {
    none("rm -rf node_modules");
    none("rm /Users/me/repo/tmp.txt");
    none("echo x > /dev/null");
    none("cat log 2>/dev/null");
    none("ls 2>&1 | tee out.log");
    none("mktemp -d /tmp/x.XXXX && cp a /tmp/x");
    none('cp a "$TMPDIR/b"');
    none("rm -rf ./dist ../repo/dist");
    none("cp a $SOME_VAR/b");
    none("sed -i 's/a/b/' src/app.ts");
    none("touch /private/var/folders/xy/T/lock");
  });

  it("resolves relative paths from the command's working directory", () => {
    none("rm -rf build", { workspace: "/Users/me/repo", cwd: "/Users/me/repo/packages/web" });
    matches("rm -rf ../../../shared", "rm outside the workspace", { workspace: "/Users/me/repo", cwd: "/Users/me/repo/packages/web" });
  });

  it("handles Windows paths", () => {
    const windows: EffectContext = { workspace: "C:\\Users\\me\\repo", cwd: "" };
    matches("rm C:\\Users\\me\\other\\x.txt", "rm outside the workspace", windows);
    none("rm C:/Users/me/repo/x.txt", windows);
    none("rm c:\\users\\me\\REPO\\x.txt", windows);
  });

  it("without a known workspace, flags only home and system paths", () => {
    const unknown: EffectContext = { workspace: null, cwd: null };
    matches("rm ~/x", "rm outside the workspace", unknown);
    matches("cp app /usr/local/bin/app", "write outside the workspace", unknown);
    none("rm /Users/me/somewhere/x", unknown);
    none("rm -rf build", unknown);
  });
});

describe("mutating HTTP requests", () => {
  it("matches requests that send or change data", () => {
    matches("curl -X POST https://api.example.com/items -d '{}'", "curl POST");
    matches("curl -XDELETE http://localhost:3000/x", "curl DELETE");
    matches("curl -sSX PUT https://x/y --data @body.json", "curl PUT");
    matches(`curl --json '{"a":1}' https://x`, "curl POST");
    matches("curl -F file=@a.png https://x/upload", "curl POST");
    matches("curl -T build.zip https://x/upload", "curl PUT");
    matches("http PUT example.com/a name=x", "http PUT");
    matches("http example.com/a name=x", "http POST");
    matches("wget --post-data a=1 https://x", "wget POST");
  });

  it("does not match reads", () => {
    none("curl https://example.com");
    none("curl -s -o out.html https://x");
    none("curl -G -d q=1 https://x");
    none("curl -X GET https://x");
    none("curl -I https://x");
    none("http GET example.com");
    none("http example.com q==1 Accept:application/json");
    none("wget https://x/file.tar.gz");
  });
});

describe("one command, several effects", () => {
  it("reports each label once, in the order the commands run", () => {
    expect(detectEffects("git push && git push --tags", WS)).toEqual([{ kind: "git-push", label: "git push", command: "git push" }]);
    expect(labels("npm publish && git push && docker push app:1")).toEqual(["npm publish", "git push", "docker push"]);
  });

  it("keeps the matched command short and on one line", () => {
    const [effect] = detectEffects(`git push origin ${"x".repeat(200)}`, WS);
    expect(effect!.command.length).toBeLessThanOrEqual(120);
    expect(effect!.command.endsWith("…")).toBe(true);
    expect(detectEffects("echo a &&\n  git   push  origin", WS)[0]!.command).toBe("git push origin");
  });
});
