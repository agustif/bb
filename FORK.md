# agustif/bb fork

This is a fork of [get-bb/bb](https://github.com/get-bb/bb) maintained at
[agustif/bb](https://github.com/agustif/bb).

## Why

- Pi mid-turn **steer** no longer surfaces `queue_update` as an unhandled SDK event
- Local packaging + install path that does **not** track npm `bb-app@latest`

## Install / update (always from this fork)

From this checkout:

```bash
# first time / after pulling changes
node scripts/update-fork-install.mjs --pull
```

After the first successful install a global helper is available:

```bash
bb-update-fork --pull
```

Environment knobs (defaults match the exe.dev / packaged layout):

| Var | Default |
|-----|---------|
| `BB_FORK_DATA_DIR` | `~/.bb` |
| `BB_FORK_SERVER_BIND_HOST` | `0.0.0.0` |
| `BB_FORK_SERVER_PORT` | `8000` |

```bash
# build + install without restarting the running process
node scripts/update-fork-install.mjs --no-restart
```

### Do not

```bash
npm install -g bb-app@latest   # upstream get-bb release channel
npx bb-app@latest              # same
npx bb-app@nightly             # upstream nightly
```

Those pull published npm builds from get-bb and will wipe the fork.

## How updates stay on the fork

1. **This script** builds `packages/bb-app` from the git checkout and
   `npm install -g`s the local tarball. The installed version is stamped
   `X.Y.Z-agustif.<gitsha>`.
2. **Host-daemon protocol self-update** downloads `/install/bb-app.tgz` from the
   **running server**. When the server is this fork install, that tarball is the
   fork package — not npm registry.
3. A cache of the last fork tarball is kept at
   `~/.bb/fork-install-cache/` for offline reinstall.

## Syncing upstream

```bash
git remote add upstream https://github.com/get-bb/bb.git   # once
git fetch upstream
git checkout main
git merge upstream/main   # or rebase
node scripts/update-fork-install.mjs
git push fork main
```

## Current fork fixes

- `fix(pi): treat queue_update as known noise so steer does not surface unhandled events`

## Related local customizations (not in this repo)

- `bb-plugin-todo` path plugin (fullscreen-expandable composer pill) lives next to
  this checkout and is installed separately via `bb plugin install`.
