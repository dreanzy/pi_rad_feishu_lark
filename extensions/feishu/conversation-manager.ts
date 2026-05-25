import { existsSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CHILD_SESSION_ENV, ensureRoot, readJson, STATE_PATH, writeJson } from "./config.js";
import type { FeishuState } from "./types.js";

export class ConversationManager {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private state: FeishuState;

  constructor(private readonly cwd: string) {
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>) {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.then(async () => {
      const session = await this.getSession(key);
      await session.prompt(userText);
      const answer = extractLastAssistantText(session);
      await onReply(answer || "No response.");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.then(async () => {
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      delete this.state.sessions[key];
      writeJson(STATE_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.then(async () => {
      const model = this.modelRegistry.find(provider, modelId);
      if (!model || !this.modelRegistry.hasConfiguredAuth(model)) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      this.state.models![key] = { provider, id: modelId };
      writeJson(STATE_PATH, this.state);

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  getAvailableModels() {
    return this.modelRegistry.getAvailable().sort((a, b) => {
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return a.id.localeCompare(b.id);
    });
  }

  getSelectedModel(key: string) {
    const selected = this.state.models?.[key];
    if (selected) {
      const model = this.modelRegistry.find(selected.provider, selected.id);
      if (model && this.modelRegistry.hasConfiguredAuth(model)) return model;
    }
    const cached = this.sessions.get(key);
    if (cached) {
      return cached.then((session) => session.model);
    }
    const available = this.getAvailableModels();
    return available[0];
  }

  resetMemory() {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
    this.queues.clear();
    this.state = { sessions: {}, models: {} };
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private async createSession(key: string): Promise<AgentSession> {
    const existingFile = this.state.sessions[key];
    const selected = this.state.models?.[key];
    const model = selected ? this.modelRegistry.find(selected.provider, selected.id) : undefined;
    const sessionManager = existingFile && existsSync(existingFile)
      ? SessionManager.open(existingFile, undefined, this.cwd)
      : SessionManager.create(this.cwd);

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => {
        const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
        return base?.trim() ? `${base}\n\n${extra}` : extra;
      },
    });

    const previousChildEnv = process.env[CHILD_SESSION_ENV];
    process.env[CHILD_SESSION_ENV] = "1";
    try {
      await loader.reload();
    } finally {
      if (previousChildEnv === undefined) delete process.env[CHILD_SESSION_ENV];
      else process.env[CHILD_SESSION_ENV] = previousChildEnv;
    }

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      sessionManager,
      resourceLoader: loader,
    });

    await session.bindExtensions({});

    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    return session;
  }
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = [...(session.messages || [])].reverse();
  for (const msg of messages as any[]) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => p?.type === "text" ? p.text : "")
        .join("")
        .trim();
    }
  }
  return "";
}
