# rad-feishu-lark

A fork of [rad-feishu-lark](https://github.com/dreanzy/pi_rad_feishu_lark) — a Feishu/Lark bridge extension for the Pi coding agent — with Windows compatibility fixes and improved process management.

## Language

**rad-feishu-lark**:
本插件名。`rad` 意为 rapid（快速），也是本项目的标识前缀。

**bashPath**:
The path to the shell binary used to spawn the daemon process. Set per-user in `~/.pi/agent/feishu/config.json`.
_Avoid_: hardcoded `"bash"`

**shellPath**:
Pi's global shell path setting from `settings.json` (project-level overrides global-level). Used as the fallback when `bashPath` is not configured.
_Avoid_: WSL bash, platform-specific hardcoding

**Daemon**:
A background Pi RPC process that maintains the WebSocket connection to Feishu/Lark. Spawned by the TUI extension via a shell `-lc` command.
_Avoid_: worker

**Gateway**:
The plugin's exclusive claim over the Feishu/Lark connection, materialised as one entry in `~/.pi/agent/locks.json`. At most one Gateway exists at a time, and it is held by exactly one Daemon.
_Avoid_: using "gateway" for the process that holds it
_Avoid_: using "gateway" for the transport or the WebSocket connection

**DaemonCommand**:
The shell command string executed by `bash -lc` to launch the daemon. Follows the pattern `tail -f /dev/null | exec pi --mode rpc ...` to keep the process alive detached from the TUI.

**autoStart**:
A boolean configuration that controls whether the TUI automatically spawns the daemon on Pi startup. Does NOT affect whether a running daemon connects to Feishu.

**Extension**:
A TypeScript module extending Pi via the `ExtensionAPI`. The feishu extension lives at `extensions/` and exports a default function that registers tools and commands.

**Locale**:
The effective language used for all user-facing text in the extension. Determined by resolving config's `language` field (if set) → `FEISHU_LANGUAGE` env var → `LANG`/`LC_ALL`/`LC_MESSAGES` terminal locale → `"en"` as the final fallback. No default is written to config — locale re-detects on every process start.
_Avoid_: hardcoded `"zh"` or `"en"` default in config/setup, bilingual string literals in source code

**Locale Module** (`locale.ts`):
Centralized translation module exporting `getLocale()`, `isZh()`, `msg(key)` for simple strings, and `t(template, vars)` for strings with interpolation. All user-facing text is looked up from the `TRANSLATIONS` table rather than hardcoded inline.
_Avoid_: inline string literals that mix Chinese and English

**⚠️ Naming Convention — `msg` reserved for locale**:
The locale module exports `msg(key)` as the translation lookup function. **Never** use `msg` as a parameter or variable name in any file that imports it — doing so shadows (hides) the locale function and causes `Pi error: msg is not a function` at runtime.
✅ Use `message` (or `feishuMsg`) for FeishuMessage parameters instead.
_Avoid_: `msg` parameter name in files that import `msg` from `locale.js`

**startupModelCheck**:
A boolean in `config.json` controlling whether the startup model check runs on Pi session start. Defaults to `true` when absent.

**Model check** (startup):
The offline validation that runs once on Pi TUI startup (`session_start` with reason `startup`, TUI mode only). It resolves every model reference persisted by the extension — `state.json` `models.*` and `config.json` `visionFallback.models` — against the model registry, and warns via notify when a reference points to an unknown model, an unauthenticated provider, or (vision entries only) a model without image input. It never writes state and never probes the network.
_Avoid_: live model probes at startup, mutating state.json during the check

**joinErrors()**:
A locale-aware utility that joins error message arrays with `"；"` (Chinese full-width semicolon) in Chinese locale, and `", "` (comma+space) in English locale.
_Avoid_: hardcoded `join("；")`
_Avoid_: Plugin, addon, package
