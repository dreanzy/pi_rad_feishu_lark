import type { FeishuCardAction, FeishuConfig, FeishuMessage } from "./types.js";

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

export class FeishuTransport {
  private sdkClient: any;
  private wsClient: any;
  private running = false;
  private botOpenId: string | undefined;

  constructor(
    private readonly config: FeishuConfig,
    private readonly onMessage: (msg: FeishuMessage) => Promise<void>,
    private readonly onCardAction: (action: FeishuCardAction) => Promise<void>,
  ) {}

  async start() {
    if (this.running) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    await this.probeBotOpenId();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
      "card.action.trigger": async (data: unknown) => this.handleCardAction(data),
      "im.message.reaction.created_v1": async () => undefined,
      "im.chat.member.bot.added_v1": async () => undefined,
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    this.running = true;
    this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop() {
    this.running = false;
    try { await this.wsClient?.stop?.(); } catch {}
  }

  isRunning() {
    return this.running;
  }

  getBotOpenId() {
    return this.botOpenId;
  }

  private async probeBotOpenId() {
    try {
      const res = await this.sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      this.botOpenId = res?.bot?.open_id || res?.data?.bot?.open_id || res?.data?.open_id;
      if (!this.botOpenId) {
        throw new Error(`bot/v3/info response missing open_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
    } catch (error) {
      throw new BotUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRawMessage(data: any) {
    const event = data?.event || data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message) return;
    if (sender?.sender_type === "bot") return;

    if (message.chat_type === "group" && this.config.groupPolicy === "mention") {
      if (!this.isMentioned(message)) return;
    }

    const msg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderOpenId: sender?.sender_id?.open_id || "unknown",
      msgType: message.message_type,
      content: message.content || "",
      rootId: message.root_id,
      parentId: message.parent_id,
      mentions: message.mentions,
    };

    if (this.config.reactEmoji) {
      void this.addReaction(msg.messageId, this.config.reactEmoji);
    }
    await this.onMessage(msg);
  }

  private async handleCardAction(data: any) {
    const event = data?.event || data;
    const messageId = event?.context?.open_message_id || event?.open_message_id;
    const chatId = event?.context?.open_chat_id || event?.open_chat_id;
    const operatorOpenId = event?.operator?.open_id;
    if (!messageId || !chatId || !operatorOpenId) return;
    await this.onCardAction({
      messageId,
      chatId,
      operatorOpenId,
      value: event?.action?.value,
    });
  }

  private isMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    const botOpenId = this.botOpenId;
    if (!botOpenId) return true;
    return mentions.some((m: any) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId);
  }

  private async addReaction(messageId: string, emojiType: string) {
    try {
      await this.sdkClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch {}
  }

  async replyText(messageId: string, text: string) {
    const chunks = splitText(text, 3500);
    for (const chunk of chunks) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      });
    }
  }

  async replyCard(messageId: string, card: object) {
    await this.sdkClient.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
  }
}

function splitText(text: string, max: number) {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (rest.length > max) {
    out.push(rest.slice(0, max));
    rest = rest.slice(max);
  }
  out.push(rest);
  return out;
}
