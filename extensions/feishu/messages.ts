import type { FeishuMessage } from "./types.js";

export function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

export function conversationKey(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
  const threadId = msg.rootId || msg.parentId;
  if (threadId) return `group:${msg.chatId}:thread:${threadId}`;
  return `group:${msg.chatId}`;
}

export function parseMessageText(msg: FeishuMessage, botOpenId?: string) {
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return text.trim();
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale: any = post.zh_cn || post.en_us || Object.values(post)[0];
      const parts: string[] = [];
      for (const para of locale?.content || []) {
        for (const elem of para) {
          if (elem.tag === "text" || elem.tag === "a") parts.push(elem.text || "");
          if (elem.tag === "at") parts.push(`@${elem.user_name || "user"}`);
        }
      }
      return parts.join("").trim();
    }
  } catch {}
  return msg.msgType === "text" ? msg.content : `[${msg.msgType}]`;
}

export function parseBotCommand(text: string): "new" | "model" | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized === "/new") return "new";
  if (normalized === "/model") return "model";
  return undefined;
}
