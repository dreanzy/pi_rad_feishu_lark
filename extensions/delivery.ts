import { loadConfig } from "./config.js";
import { debugLog } from "./debug.js";
import type { FeishuRoute } from "./types.js";
import type { FeishuTransport } from "./transport.js";
import {
	buildMarkdownCards,
	buildPostMessages,
	chooseMessageMode,
} from "./rich-text.js";
import { splitText } from "./utils.js";

const TEXT_CHUNK_MAX_BYTES = 120 * 1024;

export class FeishuDelivery {
	private sdkClient: any;

	constructor(
		private readonly getTransport: () => FeishuTransport | undefined,
	) {}

	async send(route: FeishuRoute, text: string) {
		const transport = this.getTransport();
		if (transport?.isRunning()) {
			if (route.threadMessageId)
				await transport.replyText(route.threadMessageId, text);
			else await transport.sendText(route.chatId, text);
			return;
		}

		await this.ensureClient();
		if (route.threadMessageId)
			await this.replyText(route.threadMessageId, text);
		else await this.sendText(route.chatId, text);
	}

	private async ensureClient() {
		if (this.sdkClient) return;
		const cfg = loadConfig();
		if (!cfg) throw new Error("Missing Feishu config");
		const lark = await import("@larksuiteoapi/node-sdk");
		const domain =
			cfg.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
		this.sdkClient = new lark.Client({
			appId: cfg.appId,
			appSecret: cfg.appSecret,
			appType: lark.AppType.SelfBuild,
			domain,
			loggerLevel: lark.LoggerLevel.error,
		});
	}

	private async replyText(messageId: string, text: string) {
		const mode = chooseMessageMode(text);
		if (mode === "interactive") {
			await this.replyMarkdownCard(messageId, text);
			return;
		}
		if (mode === "post") {
			await this.replyPost(messageId, text);
			return;
		}
		debugLog("feishu.bridge.reply", { messageId, length: text.length });
		for (const chunk of splitText(text, TEXT_CHUNK_MAX_BYTES)) {
			await this.sdkClient.im.message.reply({
				path: { message_id: messageId },
				data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
			});
		}
	}

	private async sendText(chatId: string, text: string) {
		const mode = chooseMessageMode(text);
		if (mode === "interactive") {
			await this.sendMarkdownCard(chatId, text);
			return;
		}
		if (mode === "post") {
			await this.sendPost(chatId, text);
			return;
		}
		debugLog("feishu.bridge.send", { chatId, length: text.length });
		for (const chunk of splitText(text, TEXT_CHUNK_MAX_BYTES)) {
			await this.sdkClient.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text: chunk }),
				},
			});
		}
	}

	private async replyMarkdownCard(messageId: string, text: string) {
		const cfg = loadConfig();
		debugLog("feishu.bridge.reply_markdown_card", {
			messageId,
			length: text.length,
		});
		for (const card of buildMarkdownCards(text, cfg?.language)) {
			await this.sdkClient.im.message.reply({
				path: { message_id: messageId },
				data: { msg_type: "interactive", content: JSON.stringify(card) },
			});
		}
	}

	private async sendMarkdownCard(chatId: string, text: string) {
		const cfg = loadConfig();
		debugLog("feishu.bridge.send_markdown_card", {
			chatId,
			length: text.length,
		});
		for (const card of buildMarkdownCards(text, cfg?.language)) {
			await this.sdkClient.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card),
				},
			});
		}
	}

	private async replyPost(messageId: string, text: string) {
		const cfg = loadConfig();
		debugLog("feishu.bridge.reply_post", { messageId, length: text.length });
		for (const post of buildPostMessages(text, cfg?.language)) {
			await this.sdkClient.im.message.reply({
				path: { message_id: messageId },
				data: { msg_type: "post", content: JSON.stringify(post) },
			});
		}
	}

	private async sendPost(chatId: string, text: string) {
		const cfg = loadConfig();
		debugLog("feishu.bridge.send_post", { chatId, length: text.length });
		for (const post of buildPostMessages(text, cfg?.language)) {
			await this.sdkClient.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "post",
					content: JSON.stringify(post),
				},
			});
		}
	}
}
