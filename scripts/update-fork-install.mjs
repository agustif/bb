#!/usr/bin/env node
/**
 * Build + globally install this bb fork as bb-app.
 *
 * Always installs from the local checkout (agustif/bb), never from npm latest.
 * Use this instead of `npm install -g bb-app@latest`.
 *
 * Usage:
 *   node scripts/update-fork-install.mjs
 *   node scripts/update-fork-install.mjs --pull
 *   node scripts/update-fork-install.mjs --no-restart
 *   BB_FORK_DATA_DIR=~/.bb BB_FORK_SERVER_PORT=8000 node scripts/update-fork-install.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const shouldPull = args.has("--pull");
const shouldRestart = !args.has("--no-restart");
const dataDir = process.env.BB_FORK_DATA_DIR ?? join(process.env.HOME ?? "", ".bb");
const serverBindHost = process.env.BB_FORK_SERVER_BIND_HOST ?? "0.0.0.0";
const serverPort = process.env.BB_FORK_SERVER_PORT ?? "8000";

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with exit ${result.status ?? "unknown"}`,
    );
  }
}

function runCapture(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
  }).trim();
}

function resolvePnpm() {
  const candidates = [
    "pnpm",
    "/usr/lib/node_modules/corepack/shims/pnpm",
    join(process.env.HOME ?? "", ".local/share/pnpm/pnpm"),
  ];
  for (const candidate of candidates) {
    const check = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (check.status === 0) {
      return candidate;
    }
  }
  throw new Error("pnpm not found; enable corepack or install pnpm first");
}

function npmCapture(commandArgs) {
  // Always run npm outside the monorepo so packageManager=pnpm does not block it.
  return runCapture("npm", commandArgs, { cwd: tmpdir() });
}

function canWriteGlobalNpmRoot() {
  try {
    const root = npmCapture(["root", "-g"]);
    // Probe rename rights the same way npm install -g does.
    const probe = join(root, ".bb-fork-write-probe");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function resolveNpmGlobalInstallCommand(tarballPath) {
  const args = ["install", "-g", tarballPath];
  if (canWriteGlobalNpmRoot()) {
    return { command: "npm", args };
  }
  // Prefer passwordless sudo when available; otherwise interactive sudo.
  return { command: "sudo", args: ["npm", ...args] };
}

function main() {
  process.chdir(repoRoot);
  const pnpm = resolvePnpm();
  const env = {
    ...process.env,
    PATH: `/usr/lib/node_modules/corepack/shims:${process.env.PATH ?? ""}`,
  };

  if (shouldPull) {
    console.log("→ fetching + fast-forwarding fork/main");
    run("git", ["fetch", "fork"], { env });
    // Stay on whatever branch carries the installable tip; prefer main.
    const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "main") {
      run("git", ["pull", "--ff-only", "fork", "main"], { env });
    } else {
      console.log(`  (on ${branch}; not auto-switching — pull manually if needed)`);
    }
  }

  const packageJsonPath = join(repoRoot, "packages/bb-app/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (pkg.name !== "bb-app") {
    throw new Error(`Expected packages/bb-app name bb-app, got ${pkg.name}`);
  }
  if (!String(pkg.repository?.url ?? "").includes("agustif/bb")) {
    throw new Error(
      "packages/bb-app/package.json repository.url must point at agustif/bb so installs stay on the fork",
    );
  }

  const sha = runCapture("git", ["rev-parse", "--short", "HEAD"]);
  // Keep a stable fork marker in the version so npm/UI can tell this apart
  // from upstream latest, without rewriting package.json on every install.
  const baseVersion = String(pkg.version).replace(/-agustif\..*$/u, "");
  const forkVersion = `${baseVersion}-agustif.${sha}`;
  const stamped = {
    ...pkg,
    version: forkVersion,
    homepage: "https://github.com/agustif/bb#readme",
    bugs: { url: "https://github.com/agustif/bb/issues" },
    repository: {
      type: "git",
      url: "git+https://github.com/agustif/bb.git",
      directory: "packages/bb-app",
    },
    description:
      pkg.description?.includes("agustif")
        ? pkg.description
        : "bb app launcher (agustif fork of get-bb/bb)",
  };
  writeFileSync(packageJsonPath, `${JSON.stringify(stamped, null, 2)}\n`);
  console.log(`→ building bb-app@${forkVersion}`);

  try {
    run(pnpm, ["install"], { env });
    run(pnpm, ["exec", "turbo", "run", "build", "--filter=bb-app"], { env });

    const packDir = mkdtempSync(join(tmpdir(), "bb-fork-pack-"));
    try {
      // Pack from /tmp so monorepo packageManager enforcement does not block npm pack.
      const packedName = runCapture(
        "npm",
        ["pack", join(repoRoot, "packages/bb-app")],
        { cwd: packDir, env },
      )
        .split("\n")
        .filter(Boolean)
        .at(-1);
      if (!packedName) {
        throw new Error("npm pack produced no tarball name");
      }
      const tarballPath = join(packDir, packedName);
      if (!existsSync(tarballPath)) {
        throw new Error(`missing tarball ${tarballPath}`);
      }

      // Keep a local copy for offline reinstalls / host-daemon serving.
      const cacheDir = join(dataDir, "fork-install-cache");
      run("mkdir", ["-p", cacheDir], { env });
      const cachedTarball = join(cacheDir, `bb-app-${forkVersion}.tgz`);
      copyFileSync(tarballPath, cachedTarball);
      writeFileSync(
        join(cacheDir, "current.json"),
        `${JSON.stringify(
          {
            version: forkVersion,
            sha,
            tarball: cachedTarball,
            repo: "https://github.com/agustif/bb",
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      console.log(`→ npm install -g ${cachedTarball}`);
      // Run outside the monorepo cwd so npm does not refuse because of the
      // root packageManager=pnpm field. Use sudo when the global prefix is root-owned.
      const install = resolveNpmGlobalInstallCommand(cachedTarball);
      run(install.command, install.args, {
        env,
        cwd: tmpdir(),
      });

      // Pin a tiny helper so `bb-update-fork` always hits this checkout.
      const binDir = join(npmCapture(["prefix", "-g"]), "bin");
      const helperPath = join(binDir, "bb-update-fork");
      const helperBody = `#!/usr/bin/env bash
set -euo pipefail
exec node ${JSON.stringify(join(repoRoot, "scripts/update-fork-install.mjs"))} "$@"
`;
      try {
        writeFileSync(helperPath, helperBody, { mode: 0o755 });
      } catch {
        const tmpHelper = join(tmpdir(), "bb-update-fork");
        writeFileSync(tmpHelper, helperBody, { mode: 0o755 });
        run("sudo", ["cp", tmpHelper, helperPath], { env });
        run("sudo", ["chmod", "755", helperPath], { env });
        rmSync(tmpHelper, { force: true });
      }
      console.log(`→ installed helper ${helperPath}`);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  } finally {
    // Restore package.json so the git tree is not dirty after every install.
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  if (shouldRestart) {
    console.log("→ restarting bb-app with fork install");
    spawnSync("bb-app", ["stop"], { env, stdio: "inherit" });
    // Detach a fresh launcher so this script can exit.
    const child = spawnSync(
      "bash",
      [
        "-lc",
        `nohup bb-app --server-bind-host ${JSON.stringify(serverBindHost)} --server-port ${JSON.stringify(serverPort)} --data-dir ${JSON.stringify(dataDir)} >/tmp/bb-app-fork.log 2>&1 &`,
      ],
      { env, stdio: "inherit" },
    );
    if (child.status !== 0) {
      throw new Error("failed to restart bb-app");
    }
  }

  console.log(`✓ installed bb-app@${forkVersion} from agustif/bb (${sha})`);
  console.log("  updates: bb-update-fork --pull");
  console.log("  do not run: npm install -g bb-app@latest  (that is upstream)");
}

main();
