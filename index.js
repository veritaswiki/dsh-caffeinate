import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import z from "@deepseek-ai/schemastery";

const execFileAsync = promisify(execFile);

export const name = "dsh-caffeinate";
export const inject = [];

export const Config = z.object({
  enabled: z.boolean().default(true).description("是否启用 DSH 防休眠守护"),
  mode: z
    .union(["always", "running-only"])
    .default("always")
    .description("守护模式：always（DSH 打开期间始终防休眠）或 running-only（仅当有 Agent 会话正在执行时防休眠）"),
  preventIdleSystemSleep: z
    .boolean()
    .default(true)
    .description("阻止系统空闲休眠（caffeinate -i）：允许屏幕正常息屏省电，但保持 CPU 与网络不断开"),
  preventSystemSleepOnAC: z
    .boolean()
    .default(true)
    .description("连接电源适配器时阻止整机睡眠（caffeinate -s）"),
  preventDiskSleep: z
    .boolean()
    .default(true)
    .description("阻止磁盘空闲休眠（caffeinate -m）"),
  preventDisplaySleep: z
    .boolean()
    .default(false)
    .description("阻止显示器息屏（caffeinate -d）：默认关闭以便正常锁屏省电；需要屏幕常亮时可开启"),
});

function normalizeConfig(raw = {}) {
  const cfg = typeof raw === "object" && raw !== null ? raw : {};
  return {
    enabled: cfg.enabled !== false,
    mode: cfg.mode === "running-only" ? "running-only" : "always",
    preventIdleSystemSleep: cfg.preventIdleSystemSleep !== false,
    preventSystemSleepOnAC: cfg.preventSystemSleepOnAC !== false,
    preventDiskSleep: cfg.preventDiskSleep !== false,
    preventDisplaySleep: Boolean(cfg.preventDisplaySleep),
  };
}

function buildCaffeinateArgs(state, hostPid) {
  const flags = [];
  if (state.preventIdleSystemSleep) flags.push("-i");
  if (state.preventSystemSleepOnAC) flags.push("-s");
  if (state.preventDiskSleep) flags.push("-m");
  if (state.preventDisplaySleep) flags.push("-d");
  if (flags.length === 0) flags.push("-i");
  flags.push("-w", String(hostPid));
  return flags;
}

async function queryPmsetAssertions() {
  if (process.platform !== "darwin") {
    return "当前平台非 macOS，不支持 pmset 查询。";
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "assertions"], {
      timeout: 4000,
    });
    const lines = stdout
      .split("\n")
      .filter((line) =>
        /PreventUserIdleSystemSleep|PreventSystemSleep|PreventUserIdleDisplaySleep|caffeinate|powerd/i.test(
          line,
        ),
      )
      .map((line) => line.trim());
    return lines.length > 0 ? lines.join("\n") : stdout.slice(0, 600);
  } catch (err) {
    return `无法读取 pmset assertions：${err instanceof Error ? err.message : String(err)}`;
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const state = {
    ...config,
    child: null,
    startedAt: null,
    lastArgs: [],
    lastError: null,
  };

  function stopCaffeinate() {
    const proc = state.child;
    state.child = null;
    state.startedAt = null;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
  }

  function startCaffeinate() {
    if (process.platform !== "darwin") {
      state.lastError = `不支持的操作系统平台: ${process.platform}`;
      return false;
    }
    stopCaffeinate();
    const args = buildCaffeinateArgs(state, process.pid);
    try {
      const proc = spawn("/usr/bin/caffeinate", args, {
        stdio: "ignore",
        detached: false,
      });
      proc.on("error", (err) => {
        state.lastError = err instanceof Error ? err.message : String(err);
        if (state.child === proc) {
          state.child = null;
          state.startedAt = null;
        }
      });
      proc.on("exit", () => {
        if (state.child === proc) {
          state.child = null;
          state.startedAt = null;
        }
      });
      proc.unref();
      state.child = proc;
      state.startedAt = new Date();
      state.lastArgs = args;
      state.lastError = null;
      return true;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  function hasRunningAgent() {
    try {
      const agents = ctx.get?.("agents");
      if (!agents || typeof agents.values !== "function") return false;
      for (const agent of agents.values()) {
        if (agent?.status === "running") return true;
      }
    } catch {}
    return false;
  }

  function reconcile() {
    if (!state.enabled) {
      stopCaffeinate();
      return;
    }
    if (state.mode === "always") {
      if (!state.child) startCaffeinate();
      return;
    }
    // running-only mode
    if (hasRunningAgent()) {
      if (!state.child) startCaffeinate();
    } else {
      stopCaffeinate();
    }
  }

  // Initial activation
  reconcile();

  // Periodic health & running-only check every 15s
  const timer = setInterval(() => {
    reconcile();
  }, 15_000);
  if (typeof timer.unref === "function") timer.unref();

  ctx.effect(() => () => {
    clearInterval(timer);
    stopCaffeinate();
  });

  async function handleCommand({ args }) {
    const sub = String(args ?? "")
      .trim()
      .toLowerCase();

    if (sub === "on" || sub === "start") {
      state.enabled = true;
      state.mode = "always";
      state.preventDisplaySleep = config.preventDisplaySleep;
      startCaffeinate();
    } else if (sub === "display" || sub === "screen") {
      state.enabled = true;
      state.mode = "always";
      state.preventDisplaySleep = true;
      startCaffeinate();
    } else if (sub === "nodisplay" || sub === "headless") {
      state.enabled = true;
      state.mode = "always";
      state.preventDisplaySleep = false;
      startCaffeinate();
    } else if (sub === "running" || sub === "auto") {
      state.enabled = true;
      state.mode = "running-only";
      reconcile();
    } else if (sub === "off" || sub === "stop") {
      state.enabled = false;
      stopCaffeinate();
    }

    const assertions = await queryPmsetAssertions();
    const isRunning = Boolean(state.child && state.child.pid);
    const uptimeSec = state.startedAt
      ? Math.max(0, Math.round((Date.now() - state.startedAt.getTime()) / 1000))
      : 0;

    return {
      kind: "success",
      text: [
        `☕ **DSH 防休眠守护 (dsh-caffeinate)**`,
        `- 守护状态：${isRunning ? `🟢 运行中 (caffeinate PID: \`${state.child.pid}\`, 绑定 DSH Host PID: \`${process.pid}\`, 已持续 ${uptimeSec}s)` : state.enabled ? "🟡 待命（running-only 模式下暂无运行中会话）" : "⚪ 已关闭"}`,
        `- 当前模式：\`${state.mode}\`（${state.mode === "always" ? "DSH 运行期间始终防休眠" : "仅当有 Agent 任务运行时防休眠"}）`,
        `- 启动参数：\`/usr/bin/caffeinate ${state.lastArgs.join(" ")}\``,
        `- 屏幕策略：${state.preventDisplaySleep ? "🔆 保持屏幕常亮 (-d)" : "🌙 允许屏幕正常息屏省电，仅阻止系统/CPU/网络/磁盘休眠 (-i -s -m)"}`,
        state.lastError ? `- 最近异常：${state.lastError}` : "",
        ``,
        `### 系统当前防休眠断言 (\`pmset -g assertions\`)`,
        "```text",
        assertions,
        "```",
        ``,
        `**可用指令**：\`/keepawake status\` · \`/keepawake on\`（允许息屏防系统休眠）· \`/keepawake display\`（连屏幕也保持常亮）· \`/keepawake running\`（仅任务运行时防休眠）· \`/keepawake off\`（关闭插件内防休眠）`,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    };
  }

  ctx.inject(["commands"], (cmdCtx) => {
    const definition = {
      description:
        "查看或控制 DSH 防休眠守护（Keep Awake）：通过 macOS caffeinate 绑定主进程防止系统/网络/磁盘休眠",
      input: {
        hint: "[status | on | display | nodisplay | running | off]",
        attachments: false,
      },
      handler: handleCommand,
    };
    cmdCtx.commands.register({ name: "keepawake", ...definition });
    cmdCtx.commands.register({ name: "caffeinate", ...definition });
  });
}

export default { name, inject, apply, Config };
