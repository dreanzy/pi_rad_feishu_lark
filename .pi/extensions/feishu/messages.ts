import type { FeishuAttachment, FeishuMessage } from "./types.js";
import { msg } from "./locale.js";

export type BotCommand =
  | { name: "new" }
  | { name: "resume" }
  | { name: "model" }
  | { name: "stop" }
  | { name: "workspace"; path?: string };

type PostBody = {
  title?: string;
  content?: unknown[];
};

export function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

export function conversationKey(message: FeishuMessage) {
  if (message.chatType === "p2p") return `p2p:${message.senderOpenId}`;
  const threadId = message.threadId || message.rootId || message.parentId;
  if (threadId) return `group:${message.chatId}:thread:${threadId}`;
  if (message.chatMode === "topic") return `group:${message.chatId}:thread:${message.messageId}`;
  return `group:${message.chatId}`;
}

export function conversationLabel(message: FeishuMessage) {
  if (message.chatType === "p2p") return msg("msg.label.p2p");
  if (message.rootId || message.parentId || message.threadId || message.chatMode === "topic") return msg("msg.label.thread");
  return msg("msg.label.group");
}

export function parseMessageInput(message: FeishuMessage, botOpenId?: string): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  try {
    const json = JSON.parse(message.content || "{}");
    if (message.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return { text: text.trim(), attachments };
    }
    if (message.msgType === "post") {
      const post = json.post || json;
      const locale = resolvePostBody(post);
      const parts: string[] = [];
      if (typeof locale?.title === "string" && locale.title.trim()) {
        parts.push(locale.title.trim());
      }
      for (const para of locale?.content || []) {
        const paragraphText = extractPostText(para, attachments).trim();
        if (paragraphText) parts.push(paragraphText);
      }
      collectAttachments(json, attachments);
      return { text: parts.join("\n").trim(), attachments };
    }
    if (message.msgType === "image" && typeof json.image_key === "string" && json.image_key) {
      attachments.push({ kind: "image", fileKey: json.image_key });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    if (message.msgType === "file" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    collectAttachments(json, attachments);
    if (attachments.length) return { text: "", attachments };
  } catch {}
  return { text: message.msgType === "text" ? message.content : `[${message.msgType}]`, attachments };
}

export function parseBotCommand(text: string): BotCommand | undefined {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  if (normalized === "/new") return { name: "new" };
  if (normalized === "/resume") return { name: "resume" };
  if (normalized === "/model") return { name: "model" };
  if (normalized === "/stop") return { name: "stop" };
  const workspaceMatch = trimmed.match(/^\/workspace(?:\s+(.+))?$/s);
  if (workspaceMatch) {
    return { name: "workspace", path: workspaceMatch[1]?.trim() };
  }
  return undefined;
}

function resolvePostBody(post: unknown): PostBody | undefined {
  if (isPostBody(post)) return post;
  if (!post || typeof post !== "object" || Array.isArray(post)) return undefined;

  const record = post as Record<string, unknown>;
  const candidates = [record.zh_cn, record.en_us, ...Object.values(record)];
  return candidates.find(isPostBody);
}

function isPostBody(value: unknown): value is PostBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content);
}

function extractPostText(node: unknown, attachments: FeishuAttachment[]): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map((item) => extractPostText(item, attachments)).join("");

  const obj = node as Record<string, unknown>;
  const tag = typeof obj.tag === "string" ? obj.tag : undefined;

  if ((tag === "img" || tag === "image") && typeof obj.image_key === "string" && obj.image_key) {
    attachments.push({ kind: "image", fileKey: obj.image_key });
    return "";
  }

  if (tag === "at") {
    return `@${typeof obj.user_name === "string" && obj.user_name ? obj.user_name : "user"}`;
  }

  if ((tag === "text" || tag === "a") && typeof obj.text === "string") {
    return obj.text;
  }

  if (typeof obj.text === "string") return obj.text;

  return Object.values(obj).map((item) => extractPostText(item, attachments)).join("");
}

function collectAttachments(value: unknown, attachments: FeishuAttachment[]) {
  const seen = new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`));
  walk(value);

  function add(attachment: FeishuAttachment) {
    const key = `${attachment.kind}:${attachment.fileKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  }

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.image_key === "string" && obj.image_key) {
      add({ kind: "image", fileKey: obj.image_key });
    }
    if (typeof obj.file_key === "string" && obj.file_key) {
      add({
        kind: "file",
        fileKey: obj.file_key,
        fileName: typeof obj.file_name === "string" ? obj.file_name : undefined,
      });
    }

    for (const item of Object.values(obj)) walk(item);
  }
}
