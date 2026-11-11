# Changelog

## [0.1.0] - 2026-11-11

First public release.

> Version note: earlier iterations used internal sequence numbers (the sections below). The public series restarts here at 0.1.0; internal numbers are not carried over.


本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 与 [语义化版本](https://semver.org/)。

## [Unreleased]

## [1.0.0] - 2026-11-10

首个公开版本。

### Added

- Host 侧守护：插件加载后 `spawn` 一个 `/usr/bin/caffeinate` 子进程，参数按设置拼装，
  末尾固定追加 `-w <Host PID>`；默认组合为 `-i -s -m -w <pid>`。
- 断言绑定宿主进程生命周期：宿主退出或崩溃后由 `caffeinate(8)` 的 `-w` 语义释放断言；
  插件卸载时额外 `clearInterval` + 对子进程 `SIGTERM`。
- 6 个 Schemastery 配置键：`enabled`、`mode`（`always` / `running-only`）、
  `preventIdleSystemSleep`、`preventSystemSleepOnAC`、`preventDiskSleep`、`preventDisplaySleep`。
- 每 15 秒一次 `reconcile()`：`always` 模式补拉子进程，`running-only` 模式按是否存在
  `status === 'running'` 的 agent 决定起停；定时器 `unref()`，不阻塞宿主退出。
- 斜杠指令 `/keepawake`（别名 `/caffeinate`）：`on` / `display` / `nodisplay` / `running` / `off`
  即时切换，其余输入落到状态报告；报告包含子进程 PID、绑定的 Host PID、已运行秒数、
  当前启动参数，以及 `pmset -g assertions` 过滤后的片段。
- `examples/com.user.caffeinate.plist`：可选的系统级 LaunchAgent 示例，插件不安装也不依赖它。

### Changed

- 公开包名统一为 `dsh-caffeinate`：`package.json` 的 `name`、`index.js` 的 `name` 导出、
  `cordis.patch.yml` 的 `insert.name` 与 `id`、以及指令输出的插件标识全部逐字一致。
- 依赖 `@deepseek-ai/schemastery` 由 DSH 自带：原先 `package.json` 里根本没声明，现补为
  `peerDependencies`（`>=3.0.0-0`）。仓库本来就不带 `node_modules`。
- 补齐开源元数据：`license`、`author`、`keywords`、`repository`、`homepage`、`bugs`、
  `publishConfig`、`files`。
- 新增 `README.en.md`、`LICENSE`、`CHANGELOG.md`、`.gitignore`、`assets/icon-180.png`、
  CI（语法 + 脱敏两道）与 `scripts/sanitize-check.mjs`。

### Notes

- 仅 macOS：非 `darwin` 平台不启动子进程，`lastError` 记录「不支持的操作系统平台」。
- 配置在 `apply()` 时读取一次，代码不监听设置变更；修改设置后何时生效取决于宿主是否重载插件。
