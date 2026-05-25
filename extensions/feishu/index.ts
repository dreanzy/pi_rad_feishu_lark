import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildModelCard, parseModelActionValue } from "./cards.js";
import { CHILD_SESSION_ENV, CONFIG_PATH, ensureRoot, loadConfig, mask, removePath, STATE_PATH, writeJson } from "./config.js";
import { ConversationManager } from "./conversation-manager.js";
import { conversationKey, normalizeForDedupe, parseBotCommand, parseMessageText, pruneRecentMap } from "./messages.js";
import { runSetup, uiConfirm } from "./setup.js";
import { BotUnavailableError, FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuStatus } from "./types.js";

export default function feishuExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_SESSION_ENV] === "1") {
    return;
  }

  let transport: FeishuTransport | undefined;
  const conversations = new ConversationManager(process.cwd());
  const seen = new Set<string>();
  const recentContent = new Map<string, number>();
  const CONTENT_DEDUPE_TTL_MS = 30_000;

  const STATUS_KEY = "feishu-connection";
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  let lastStatusText: string | undefined;

  function setStatusText(text: string | undefined) {
    if (lastStatusText === text) return;
    lastStatusText = text;
    uiRef?.setStatus?.(STATUS_KEY, text);
  }

  function updateStatus(status: FeishuStatus) {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    setStatusText(`${brand}: ${status}`);
  }

  function clearStatus() {
    lastStatusText = undefined;
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  }

  async function start(config?: FeishuConfig) {
    if (transport?.isRunning()) {
      updateStatus("connected");
      return "already";
    }
    const cfg = config || loadConfig();
    if (!cfg) {
      updateStatus("not configured");
      throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
    }
    updateStatus("connecting");
    transport = new FeishuTransport(cfg, async (msg) => {
      if (seen.has(msg.messageId)) return;
      seen.add(msg.messageId);
      if (seen.size > 2000) seen.clear();

      const text = parseMessageText(msg, transport?.getBotOpenId());
      if (!text) return;
      const key = conversationKey(msg);

      const command = parseBotCommand(text);
      if (command === "new") {
        await conversations.newConversation(key, async (reply) => {
          await transport?.replyText(msg.messageId, reply);
        });
        return;
      }
      if (command === "model") {
        const models = conversations.getAvailableModels();
        if (!models.length) {
          await transport?.replyText(msg.messageId, "当前没有可用模型。请先在 Pi 里完成模型登录或 API Key 配置。");
          return;
        }
        const currentModel = await conversations.getSelectedModel(key);
        await transport?.replyCard(msg.messageId, buildModelCard(key, models, currentModel));
        return;
      }

      const now = Date.now();
      const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text)].join("\u0000");
      const previousContentAt = recentContent.get(contentKey);
      if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return;
      recentContent.set(contentKey, now);
      if (recentContent.size > 2000) pruneRecentMap(recentContent, now, CONTENT_DEDUPE_TTL_MS);

      const prompt = msg.chatType === "group"
        ? `[Feishu group/topic: ${key}]\n${text}`
        : `[Feishu private chat]\n${text}`;

      await conversations.prompt(key, prompt, async (reply) => {
        await transport?.replyText(msg.messageId, reply);
      });
    }, async (action) => {
      const selected = parseModelActionValue(action.value);
      if (!selected) return;
      await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
    });
    try {
      await transport.start();
      updateStatus("connected");
      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      throw error;
    }
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark bridge: setup, start, stop, status, reset, autostart",
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const [cmdRaw, argRaw] = args.trim().toLowerCase().split(/\s+/, 2);
      const cmd = cmdRaw || "status";
      const arg = argRaw || "";
      try {
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            const result = await start(configToStart);
            ctx.ui.notify(result === "already" ? "Feishu already running / 飞书已在运行" : "Feishu started / 飞书已启动", "info");
          }
          return;
        }
        if (cmd === "start") {
          const result = await start();
          ctx.ui.notify(result === "already" ? "Feishu already running / 飞书已在运行" : "Feishu started / 飞书已启动", "info");
          return;
        }
        if (cmd === "stop") {
          await transport?.stop();
          transport = undefined;
          updateStatus(loadConfig() ? "disconnected" : "not configured");
          ctx.ui.notify("Feishu stopped / 飞书已停止", "info");
          return;
        }
        if (cmd === "reset") {
          const ok = await uiConfirm(
            ctx,
            "确认重置飞书扩展？会删除配置和会话映射，但保留所有会话历史。 / Reset Feishu extension? This deletes config and conversation mappings, but keeps all session history.",
            false,
          );
          if (!ok) {
            ctx.ui.notify("Reset cancelled / 已取消重置", "info");
            return;
          }
          await transport?.stop();
          transport = undefined;
          removePath(CONFIG_PATH);
          removePath(STATE_PATH);
          conversations.resetMemory();
          seen.clear();
          recentContent.clear();
          ensureRoot();
          updateStatus("not configured");
          ctx.ui.notify(
            "Feishu extension reset. Session history was kept. Run /feishu setup. / 飞书扩展已重置，会话历史已保留，请运行 /feishu setup。",
            "info",
          );
          return;
        }
        if (cmd === "status") {
          const cfg = loadConfig();
          ctx.ui.notify(
            [
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "autostart") {
          const cfg = loadConfig();
          if (!cfg) {
            ctx.ui.notify("Missing config. Run /feishu setup first.", "warning");
            return;
          }
          if (arg === "on") {
            cfg.autoStart = true;
            writeJson(CONFIG_PATH, cfg);
            ctx.ui.notify("AutoStart enabled.", "info");
            return;
          }
          if (arg === "off") {
            cfg.autoStart = false;
            writeJson(CONFIG_PATH, cfg);
            ctx.ui.notify("AutoStart disabled.", "info");
            return;
          }
          ctx.ui.notify(`AutoStart: ${cfg.autoStart !== false}. Usage: /feishu autostart on|off|status`, "info");
          return;
        }
        ctx.ui.notify("Usage: /feishu setup | start | stop | status | reset | autostart on|off|status", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const bootConfig = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    uiRef = ctx.ui as any;
    if (lastStatusText) {
      uiRef?.setStatus?.(STATUS_KEY, lastStatusText);
      return;
    }
    if (transport?.isRunning()) {
      updateStatus("connected");
    } else if (!bootConfig) {
      updateStatus("not configured");
    } else if (bootConfig.autoStart === false) {
      updateStatus("disconnected");
    } else {
      updateStatus("connecting");
    }
  });

  if (bootConfig?.autoStart !== false) {
    start().catch((error) => {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      console.error("[feishu] autoStart failed:", error instanceof Error ? error.message : error);
    });
  }

  pi.on("session_shutdown", async () => {
    await transport?.stop();
    clearStatus();
  });
}
