# dsh-caffeinate — DSH 运行期间不让 Mac 睡过去

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node 20](https://img.shields.io/badge/node-20-blue.svg)](./.github/workflows/ci.yml)
[![macOS only](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#已知限制)

<!-- npm 徽章：`dsh-caffeinate` 发布后再补 https://img.shields.io/npm/v/dsh-caffeinate -->

> 一个 Host 侧 DSH 插件：拉一个 macOS 自带的 `caffeinate` 子进程，用 `-w` 把防休眠断言绑到 DSH 主进程上。宿主没了，断言跟着没；屏幕该息屏还是息屏。

## 它做什么

1. **拉起一个 `caffeinate` 子进程** —— 插件加载时 `spawn("/usr/bin/caffeinate", args)`，`stdio: "ignore"`、`detached: false`，随后 `unref()`，不拖住宿主退出。
2. **参数由设置决定，末尾固定 `-w <Host PID>`** —— 默认拼出来是 `/usr/bin/caffeinate -i -s -m -w <pid>`；不勾「阻止显示器休眠」就不带 `-d`。
3. **断言绑在宿主进程上** —— `-w` 的语义来自 `caffeinate(8)`：「等待指定 pid 的进程退出，进程退出后断言一并释放」。所以 DSH 正常退出或被杀掉之后，不会留下一个继续压着系统的孤儿 `caffeinate`。
4. **每 15 秒自检一次** —— `setInterval(reconcile, 15000)`：`always` 模式下子进程没了就重拉；`running-only` 模式下按「有没有正在执行的 agent」决定起停。
5. **斜杠指令随时看随时切** —— `/keepawake`（别名 `/caffeinate`）能报当前状态、子进程 PID、绑定的宿主 PID、已运行秒数、实际启动参数，并附一段 `pmset -g assertions` 的过滤结果；也能直接切模式。
6. **卸载清理** —— `ctx.effect` 的清理函数里 `clearInterval` 并对子进程发 `SIGTERM`。

## 它怎么做

### 参数拼装（`buildCaffeinateArgs`）

| 配置键 | 默认 | 拼进去的参数 | 含义（依 `caffeinate(8)`） |
| --- | --- | --- | --- |
| `preventIdleSystemSleep` | `true` | `-i` | 阻止系统空闲休眠 |
| `preventSystemSleepOnAC` | `true` | `-s` | 阻止整机睡眠；这条断言只在交流电下有效 |
| `preventDiskSleep` | `true` | `-m` | 阻止磁盘空闲休眠 |
| `preventDisplaySleep` | `false` | `-d` | 阻止显示器休眠 |
| 四个全关时 | — | 兜底 `-i` | 代码里 flags 为空会补一个 `-i` |
| 固定尾部 | — | `-w <pid>` | 监视宿主进程，`process.pid` |

默认全开（`-d` 除外）时，实际命令行是：

```text
/usr/bin/caffeinate -i -s -m -w <DSH 主进程 PID>
```

**绑的是谁的 pid**：`buildCaffeinateArgs(state, process.pid)` —— 即运行插件的那个 DSH 宿主进程，不是 `caffeinate` 自己的 pid，也不是它 fork 出去的任何子进程。

### 生命周期

| 时机 | 行为 |
| --- | --- |
| 插件加载 | `apply()` 里先跑一次 `reconcile()` |
| 每 15 秒 | `setInterval` 再跑一次 `reconcile()`，定时器 `unref()` |
| 插件卸载 | `clearInterval` + 对子进程 `kill("SIGTERM")` |
| 宿主进程消失 | 由 `caffeinate -w` 自行释放断言并退出 |
| 子进程自己退出 / 起不来 | `exit` / `error` 回调把 `state.child` 清空，下一次 `reconcile()` 重拉；错误记进 `state.lastError` |

### `reconcile()` 的三种结果

- `enabled === false` → 停掉子进程；
- `mode === "always"` → 没有子进程就起一个；
- `mode === "running-only"` → 有 `status === "running"` 的 agent 才起，否则停。

判断方式是从宿主取 `agents` 服务，遍历其 `values()` 看 `status`。

## 安装

本插件是 DSH（Cordis）bundle。两种装法。

### 方式 A：让 Agent 用 `plugin_manager` 安装

在 DSH 里对 Agent 说「装 `dsh-caffeinate`」，它会调 `plugin_manager`：

- `action: "install_bundle"`，`target` 填安装 spec：
  - 已 clone 到本地：`file:/abs/path/to/dsh-caffeinate`
  - GitHub 上的仓库：`github:veritaswiki/dsh-caffeinate`
  - 或直接填 npm 包名 `dsh-caffeinate`（需已发布到 registry）
- 装完 `action: "set_bundle"` 启用。

> 首发状态：包名已定为 `dsh-caffeinate`，但**还没有发布到 npm registry**，所以现在在 npm 上搜不到。发布前请用上面的 `github:` 或 `file:` spec。

### 方式 B：手动挂到 profile

1. 把仓库放在任意目录（下面记作 `/abs/path/to/dsh-caffeinate`）。
2. 编辑 profile 的 `package.json`（`~/.dsh/profiles/<profile>/package.json`）：
   - `dependencies` 里加 `"dsh-caffeinate": "link:/abs/path/to/dsh-caffeinate"`
   - `dsh.profile.bundles` 数组里加 `"dsh-caffeinate"`
3. 在 profile 目录安装依赖（DSH 下次启动时也会自行安装）。

### 依赖说明

`index.js` 需要 `@deepseek-ai/schemastery`（Host 侧配置校验）。**DSH 自带这个包**，正常安装不需要另装；`package.json` 里它是 `peerDependencies`（`>=3.0.0-0`），只用来把依赖关系写明。本仓库不带 `node_modules`。

## 配置

配置项在插件的标准设置表单里（Schemastery `Config`）：

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用守护 |
| `mode` | `"always"` \| `"running-only"` | `"always"` | `always` = DSH 打开期间一直防休眠；`running-only` = 只有 agent 在执行时才防休眠 |
| `preventIdleSystemSleep` | boolean | `true` | 对应 `-i` |
| `preventSystemSleepOnAC` | boolean | `true` | 对应 `-s` |
| `preventDiskSleep` | boolean | `true` | 对应 `-m` |
| `preventDisplaySleep` | boolean | `false` | 对应 `-d`；默认关闭，屏幕照常息屏锁屏 |

非法值的行为（`normalizeConfig`）：布尔项除显式 `false` 外都按 `true`；`mode` 除显式 `"running-only"` 外都按 `"always"`；`preventDisplaySleep` 走 `Boolean()`，非真值即 `false`。

配置在 `apply()` 时读一次即定型，代码里没有监听配置变更的分支。

## 斜杠指令

`/keepawake` 与 `/caffeinate` 注册的是同一套逻辑，子命令行为如下：

| 输入 | 内存状态变化 | 是否重启子进程 |
| --- | --- | --- |
| `/keepawake status`（或空、或任何未识别的词） | 无 | 否，只报告 |
| `/keepawake on` / `start` | `enabled=true`、`mode=always`、屏幕策略回到配置里的 `preventDisplaySleep` 值 | 是（先停再起，PID 与运行时长归零） |
| `/keepawake display` / `screen` | `enabled=true`、`mode=always`、`preventDisplaySleep=true` | 是 |
| `/keepawake nodisplay` / `headless` | `enabled=true`、`mode=always`、`preventDisplaySleep=false` | 是 |
| `/keepawake running` / `auto` | `enabled=true`、`mode=running-only` | 否，交给 `reconcile()` 决定 |
| `/keepawake off` / `stop` | `enabled=false` | 是（停） |

注意 `status` 不是独立分支：代码里没有 `status` 判断，它和不认识的词一样落到「只报告」这条默认路径上。

每次执行完都会返回同一份报告：守护状态、当前 `mode`、实际启动参数、屏幕策略、最近异常（若有），以及 `pmset -g assertions` 里匹配 `PreventUserIdleSystemSleep`、`PreventSystemSleep`、`PreventUserIdleDisplaySleep`、`caffeinate`、`powerd` 的行（`pmset` 超时 4 秒，取不到就截前 600 字符，非 macOS 直接说明不支持）。

## 已知限制

- **仅 macOS**。非 `darwin` 平台不会 `spawn`，`state.lastError` 记下「不支持的操作系统平台」，指令报告里能看到；`pmset` 那一段也会说明平台不支持。
- **需要 `/usr/bin/caffeinate` 存在**（macOS 自带）。插件不检查路径、不做安装提示；`spawn` 失败只会进 `lastError`。
- **`-w` 绑的是宿主主进程 pid**。DSH fork 出去的进程不在绑定范围内：它们不在时不会让 `caffeinate` 续命，它们还在时也不会让 `caffeinate` 多活——主进程一走，这一层断言就结束。
- **`running-only` 依赖宿主暴露 `agents` 服务**，且 agent 的 `status` 为 `"running"`。取不到该服务时判断恒为「没有正在执行的 agent」，结果是这个模式下不会拉起 `caffeinate`（宁可不防，也不乱防）。
- **15 秒轮询**：`running-only` 的起停最多有 15 秒延迟，不是事件驱动的即时反应。
- **指令改动不落盘**：`/keepawake` 只改内存里的状态，不写配置。重载插件后回到配置文件里的值。
- **`/keepawake display`、`/keepawake nodisplay` 会把 `mode` 强制成 `always`**：想同时保持「屏幕常亮 + 仅任务执行时防休眠」当前做不到，得二选一。
- **`/keepawake on` 不会强制开屏幕常亮**，它把屏幕策略恢复成配置里的值——如果配置里 `preventDisplaySleep` 是 `false`，它就是关的。
- **`-s` 只在交流电下有效**，这是 `caffeinate` 自身语义，插件不额外判断电源状态。
- **不改断言的叠加关系**：若机器上另有系统级 `caffeinate`（例如 `examples/com.user.caffeinate.plist` 那种常驻 LaunchAgent），两层断言会同时存在，`/keepawake off` 只关插件这一层。
- **没有单元测试**：门禁是 `node --check` 加脱敏扫描，`scripts/sanitize-check.mjs` 不覆盖行为。

## 与其它实现的关系

同一个问题还有一份实现：`bearice/dsh-keep-awake`（npm 包名 `dsh-keep-awake`）。它走跨平台路线，并提供可视化的双语设置页；本包只做 macOS，交互面放在斜杠指令上。本包之所以叫 `dsh-caffeinate` 而不是 `dsh-keep-awake`，是因为后者在 npm 上已被占用。

取舍写在明面上：直接用系统自带的 `caffeinate`、把生命周期交给 `-w`，换来的是几乎为零的平台层代码和一个可脚本化、可回滚的命令面；代价是只能在 macOS 上跑，屏幕上也没有独立面板（配置在插件标准设置表单里）。需要跨平台就用那一份，只需要 Mac 上安静地不合盖，用这份就够。

## 开发与检查

```bash
node --check index.js
node scripts/sanitize-check.mjs
```

`scripts/sanitize-check.mjs` 是脱敏门禁：本机绝对路径、私有包前缀、回环地址、内网地址段、密钥与令牌前缀一律不许出现，命中即退出码 1。CI（`.github/workflows/ci.yml`）在 Node 20 上只跑这两步，不发布 npm。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` 指回 `cordis.patch.yml` |
| `cordis.patch.yml` | 插入一行 Loader 条目（`insert.name` 必须等于包名） |
| `index.js` | Host 侧全部逻辑：配置、`caffeinate` 起停、`reconcile`、两个斜杠指令 |
| `locale/zh.json`、`locale/en.json` | 插件管理页的标题与描述 |
| `icon.svg` | 插件图标（源码） |
| `assets/icon-180.png` | 180×180 位图，供需要位图图标的场合使用 |
| `examples/com.user.caffeinate.plist` | 可选的系统级 LaunchAgent 示例；插件不安装、不读取、不依赖它 |

## License

MIT © 2026 veritaswiki
