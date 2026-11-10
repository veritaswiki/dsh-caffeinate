# dsh-caffeinate — keep the Mac awake while DSH runs

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node 20](https://img.shields.io/badge/node-20-blue.svg)](./.github/workflows/ci.yml)
[![macOS only](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#known-limitations)

<!-- npm badge: add https://img.shields.io/npm/v/dsh-caffeinate once the package is published -->

> A host-side DSH plugin: it spawns the `caffeinate` that ships with macOS and binds the assertion to the DSH main process with `-w`. When the host goes away, the assertion goes away. The display still sleeps as usual.

## What it does

1. **Spawns one `caffeinate` child** — on plugin load it runs `spawn("/usr/bin/caffeinate", args)` with `stdio: "ignore"`, `detached: false`, then `unref()`, so it never holds the host open.
2. **Arguments come from settings, with `-w <host pid>` always appended** — the default build is `/usr/bin/caffeinate -i -s -m -w <pid>`; no `-d` unless display sleep prevention is enabled.
3. **The assertion is bound to the host process** — `-w` in `caffeinate(8)` means "wait for the process with the specified pid to exit; once it exits, the assertion is also released". A DSH exit or kill therefore does not leave an orphaned `caffeinate` holding the machine awake.
4. **Re-checks every 15 seconds** — `setInterval(reconcile, 15000)`: in `always` mode a missing child is restarted; in `running-only` mode the child is started and stopped based on whether any agent is running.
5. **Slash commands read and switch live** — `/keepawake` (alias `/caffeinate`) reports state, child PID, the host PID it is bound to, uptime in seconds, the exact spawn arguments, and a filtered excerpt of `pmset -g assertions`; it also switches modes.
6. **Cleanup on unmount** — the `ctx.effect` disposer calls `clearInterval` and sends `SIGTERM` to the child.

## How it works

### Argument assembly (`buildCaffeinateArgs`)

| Config key | Default | Flag | Meaning (per `caffeinate(8)`) |
| --- | --- | --- | --- |
| `preventIdleSystemSleep` | `true` | `-i` | prevent system idle sleep |
| `preventSystemSleepOnAC` | `true` | `-s` | prevent system sleep; valid only on AC power |
| `preventDiskSleep` | `true` | `-m` | prevent disk idle sleep |
| `preventDisplaySleep` | `false` | `-d` | prevent display sleep |
| all four off | — | fallback `-i` | if the flag list is empty, `-i` is added |
| always appended | — | `-w <pid>` | watch the host process, `process.pid` |

With the defaults the real command line is:

```text
/usr/bin/caffeinate -i -s -m -w <DSH main process PID>
```

**Whose pid is watched**: `buildCaffeinateArgs(state, process.pid)` — the DSH host process that loaded the plugin, not `caffeinate` itself and not anything it forks.

### Lifecycle

| Moment | Behavior |
| --- | --- |
| Plugin load | `apply()` calls `reconcile()` once |
| Every 15 s | `setInterval` calls `reconcile()` again; the timer is `unref()`ed |
| Plugin unload | `clearInterval` + `kill("SIGTERM")` on the child |
| Host process gone | `caffeinate -w` releases the assertion and exits on its own |
| Child exits or fails to start | `exit` / `error` handlers clear `state.child`; the next `reconcile()` restarts it, errors land in `state.lastError` |

### The three `reconcile()` outcomes

- `enabled === false` → stop the child;
- `mode === "always"` → start a child if there is none;
- `mode === "running-only"` → start only if some agent has `status === "running"`, otherwise stop.

That check reads the host's `agents` service and scans its `values()` for `status`.

## Install

This plugin is a DSH (Cordis) bundle. Two ways in.

### Option A: let the agent use `plugin_manager`

Ask the agent inside DSH to install `dsh-caffeinate`; it calls `plugin_manager`:

- `action: "install_bundle"`, with `target` set to an install spec:
  - local clone: `file:/abs/path/to/dsh-caffeinate`
  - the GitHub repo: `github:veritaswiki/dsh-caffeinate`
  - or the npm name `dsh-caffeinate` (only once published to the registry)
- then `action: "set_bundle"` to enable it.

> Release status: the name is fixed as `dsh-caffeinate`, but the package is **not published to npm yet**, so `npm` search will not find it. Until it is, use the `github:` or `file:` spec above.

### Option B: mount it into a profile by hand

1. Put the repo anywhere (referred to below as `/abs/path/to/dsh-caffeinate`).
2. Edit the profile's `package.json` (`~/.dsh/profiles/<profile>/package.json`):
   - add `"dsh-caffeinate": "link:/abs/path/to/dsh-caffeinate"` to `dependencies`
   - add `"dsh-caffeinate"` to the `dsh.profile.bundles` array
3. Install dependencies in the profile directory (DSH also does this on next start).

### About the dependency

`index.js` needs `@deepseek-ai/schemastery` for host-side config validation. **DSH ships that package**, so a normal install needs nothing extra; `package.json` declares it under `peerDependencies` (`>=3.0.0-0`) only to state the relationship. This repo ships no `node_modules`.

## Configuration

Settings live in the plugin's standard form (Schemastery `Config`):

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | master switch |
| `mode` | `"always"` \| `"running-only"` | `"always"` | `always` = stay awake the whole time DSH is open; `running-only` = only while an agent is executing |
| `preventIdleSystemSleep` | boolean | `true` | maps to `-i` |
| `preventSystemSleepOnAC` | boolean | `true` | maps to `-s` |
| `preventDiskSleep` | boolean | `true` | maps to `-m` |
| `preventDisplaySleep` | boolean | `false` | maps to `-d`; off by default so the display still sleeps and locks |

Invalid values (`normalizeConfig`): booleans are `true` unless explicitly `false`; `mode` is `"always"` unless explicitly `"running-only"`; `preventDisplaySleep` goes through `Boolean()`, so anything not truthy becomes `false`.

Config is read once at `apply()` time; there is no config-change listener in the code.

## Slash commands

`/keepawake` and `/caffeinate` register the same logic. Subcommand behavior:

| Input | In-memory change | Restarts the child |
| --- | --- | --- |
| `/keepawake status` (or empty, or any unrecognized word) | none | no, report only |
| `/keepawake on` / `start` | `enabled=true`, `mode=always`, display policy reset to the configured `preventDisplaySleep` | yes (stop then start; PID and uptime reset) |
| `/keepawake display` / `screen` | `enabled=true`, `mode=always`, `preventDisplaySleep=true` | yes |
| `/keepawake nodisplay` / `headless` | `enabled=true`, `mode=always`, `preventDisplaySleep=false` | yes |
| `/keepawake running` / `auto` | `enabled=true`, `mode=running-only` | no, left to `reconcile()` |
| `/keepawake off` / `stop` | `enabled=false` | yes (stop) |

Note that `status` is not a branch of its own: there is no `status` check in the code, so it lands on the same report-only default path as an unknown word.

Every invocation returns the same report: state, current `mode`, the exact spawn arguments, display policy, the last error if any, and the `pmset -g assertions` lines matching `PreventUserIdleSystemSleep`, `PreventSystemSleep`, `PreventUserIdleDisplaySleep`, `caffeinate` or `powerd` (4-second timeout, first 600 characters as a fallback, and a plain "not supported" line on non-macOS).

## Known limitations

- **macOS only.** On any platform other than `darwin` nothing is spawned and `state.lastError` records an unsupported-platform message; the `pmset` part of the report says so too.
- **Requires `/usr/bin/caffeinate`** (bundled with macOS). The plugin does not check for it or advise on install; a failed `spawn` only shows up in `lastError`.
- **`-w` watches the host main process pid.** Processes DSH forks are outside the binding: their absence cannot keep `caffeinate` alive and their presence cannot extend it — when the main process goes, this layer of assertion ends.
- **`running-only` depends on the host exposing an `agents` service** with `status === "running"`. When that service is unavailable the check is always false, so this mode never starts `caffeinate` (it fails toward not holding the machine awake).
- **15-second polling**: start/stop in `running-only` can lag by up to 15 seconds; it is not event driven.
- **Command changes are not persisted**: `/keepawake` only mutates in-memory state. A plugin reload returns to the configured values.
- **`/keepawake display` and `/keepawake nodisplay` force `mode` to `always`**: "display stays on" and "only while an agent runs" cannot currently be combined.
- **`/keepawake on` does not force the display to stay on** — it restores the display policy from config, so if `preventDisplaySleep` is `false` the display still sleeps.
- **`-s` is only effective on AC power**; that is `caffeinate`'s own semantics, and the plugin does not inspect power state.
- **Assertions are not merged**: if the machine also runs a system-level `caffeinate` (for example the resident LaunchAgent in `examples/com.user.caffeinate.plist`), both layers hold assertions at once and `/keepawake off` only turns off the plugin's layer.
- **No unit tests**: the gate is `node --check` plus the sanitization scan; `scripts/sanitize-check.mjs` checks text, not behavior.

## Relation to other implementations

The same problem has another implementation: `bearice/dsh-keep-awake` (npm name `dsh-keep-awake`). It takes the cross-platform route and offers a visual, bilingual settings page; this package is macOS-only and puts its control surface in slash commands. This package is named `dsh-caffeinate` rather than `dsh-keep-awake` because the latter name is already taken on npm.

The tradeoff is stated plainly: calling the system's own `caffeinate` and delegating lifetime to `-w` buys near-zero platform code plus a scriptable, reversible command surface; it costs macOS-only support and no separate panel (settings live in the plugin's standard config form). Use that one if you need multiple platforms; use this one if you only need a Mac to keep working with the lid open.

## Development and checks

```bash
node --check index.js
node scripts/sanitize-check.mjs
```

`scripts/sanitize-check.mjs` is the sanitization gate: absolute home paths, private package scopes, loopback addresses, internal address ranges, and key/token prefixes are all rejected, and any hit exits with code 1. CI (`.github/workflows/ci.yml`) runs exactly these two steps on Node 20 and does not publish to npm.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | bundle manifest: `dsh.bundle.patch` points at `cordis.patch.yml` |
| `cordis.patch.yml` | inserts one loader entry (`insert.name` must equal the package name) |
| `index.js` | all host-side logic: config, `caffeinate` start/stop, `reconcile`, both slash commands |
| `locale/zh.json`, `locale/en.json` | plugin manager title and description |
| `icon.svg` | icon source |
| `assets/icon-180.png` | 180x180 bitmap for consumers that need a raster icon |
| `examples/com.user.caffeinate.plist` | optional system-level LaunchAgent example; the plugin does not install, read or depend on it |

## License

MIT © 2026 veritaswiki
