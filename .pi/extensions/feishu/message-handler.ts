import {
	detectCodeLanguage,
	decodeTextFile,
	detectImageMime,
	type FeishuImageInput,
	isSupportedImageMime,
	isSupportedTextFile,
} from "./attachments.js";
import {
	buildModelCard,
	buildResumeCard,
	buildWorkspaceListCard,
} from "./cards.js";
import type { ConversationManager } from "./conversation-manager.js";
import { claimFeishuMessage, markFeishuMessage } from "./dedupe-store.js";
import { debugLog } from "./debug.js";
import {
	conversationKey,
	conversationLabel,
	normalizeForDedupe,
	parseBotCommand,
	parseMessageInput,
	pruneRecentMap,
} from "./messages.js";
import { TaskStatusCard } from "./task-status-card.js";
import type { FeishuBridgeStore } from "./bridge-store.js";
import type { FeishuTransport } from "./transport.js";
import type { FeishuMessage } from "./types.js";
import { joinErrors, msg, t } from "./locale.js";

const CONTENT_DEDUPE_TTL_MS = 5_000;

export class FeishuMessageHandler {
	private readonly seen = new Set<string>();
	private readonly recentContent = new Map<string, number>();

	constructor(
		private readonly conversations: ConversationManager,
		private readonly getTransport: () => FeishuTransport | undefined,
		private readonly bridgeStore?: FeishuBridgeStore,
	) {}

	reset() {
		this.seen.clear();
		this.recentContent.clear();
	}

	async handle(message: FeishuMessage) {
		const transport = this.getTransport();
		if (!transport) return;

		try {
			if (this.seen.has(message.messageId)) return;
			if (!(await claimFeishuMessage(message.messageId))) return;
			this.seen.add(message.messageId);
			if (this.seen.size > 2000) this.seen.clear();

			const parsed = parseMessageInput(message, transport.getBotOpenId());
			const text = parsed.text || "";
			const key = conversationKey(message);
			this.bridgeStore?.bindConversation(key, message);
			debugLog("feishu.handler.parsed", {
				messageId: message.messageId,
				key,
				chatMode: message.chatMode,
				threadId: message.threadId || message.rootId || message.parentId,
				textLength: text.length,
				attachments: parsed.attachments.map((item) => ({
					kind: item.kind,
					fileKey: item.fileKey,
					fileName: item.fileName,
				})),
			});

			if (!parsed.attachments.length) {
				if (!text) {
					await markFeishuMessage(message.messageId, "ignored");
					return;
				}
				const handled = await this.handleCommand(message, key, text);
				if (handled) {
					await markFeishuMessage(message.messageId, "replied");
					return;
				}
			}

			if (this.isDuplicateContent(message, key, text, parsed.attachments)) {
				await markFeishuMessage(message.messageId, "ignored");
				return;
			}

			const model = await this.conversations.getSelectedModel(key);
			const modelSupportsImage = Boolean(
				model &&
					Array.isArray((model as any).input) &&
					(model as any).input.includes("image"),
			);
			debugLog("feishu.handler.model", {
				messageId: message.messageId,
				key,
				model: model
					? `${(model as any).provider}/${(model as any).id}`
					: undefined,
				modelSupportsImage,
			});

			const processed = await this.processAttachments(
				message,
				parsed.attachments,
				modelSupportsImage,
			);
			const { imageInputs, fileSections, downloadErrors, skippedImageCount } =
				processed;

			if (
				skippedImageCount > 0 &&
				imageInputs.length === 0 &&
				!fileSections.length &&
				!text.trim()
			) {
				await transport.replyText(
					message.messageId,
					msg("handler.image.unsupported_model"),
				);
				await markFeishuMessage(message.messageId, "replied");
				return;
			}

			if (
				downloadErrors.length &&
				!imageInputs.length &&
				!fileSections.length &&
				!text.trim()
			) {
				await transport.replyText(
					message.messageId,
					t("handler.no_content", { errors: joinErrors(downloadErrors) }),
				);
				await markFeishuMessage(message.messageId, "replied");
				return;
			}

			const prompt = buildPrompt(
				message,
				text,
				fileSections,
				imageInputs,
				skippedImageCount,
				modelSupportsImage,
				downloadErrors,
			);
			const status = new TaskStatusCard(key, message.messageId, transport);
			await status.start();
			await this.conversations.promptWithImages(
				key,
				prompt,
				imageInputs,
				async (reply) => {
					await transport.replyText(message.messageId, reply);
				},
				status,
			);
			await markFeishuMessage(message.messageId, "replied");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugLog("feishu.handler.error", {
				messageId: message.messageId,
				error: message,
			});
			await markFeishuMessage(message.messageId, "failed", message);
			await this.getTransport()?.replyText(
				message.messageId,
				`Pi error: ${message}`,
			);
		}
	}

	private async handleCommand(
		message: FeishuMessage,
		key: string,
		text: string,
	) {
		const command = parseBotCommand(text);
		if (!command) return false;

		const transport = this.getTransport();
		if (!transport) return true;

		if (command.name === "new") {
			await this.conversations.newConversation(key, async (reply) => {
				await transport.replyText(message.messageId, reply);
			});
			return true;
		}

		if (command.name === "model") {
			const models = this.conversations.getAvailableModels();
			if (!models.length) {
				await transport.replyText(message.messageId, msg("handler.model.none"));
				return true;
			}
			const currentModel = await this.conversations.getSelectedModel(key);
			await transport.replyCard(
				message.messageId,
				buildModelCard(key, models, currentModel),
			);
			return true;
		}

		if (command.name === "resume") {
			const page = await this.conversations.listResumeSessions(
				key,
				"current",
				0,
			);
			await transport.replyCard(message.messageId, buildResumeCard(page));
			return true;
		}

		if (command.name === "stop") {
			await this.conversations.stopConversation(key, async (reply) => {
				await transport.replyText(message.messageId, reply);
			});
			return true;
		}

		if (command.name === "workspace") {
			await this.conversations.switchWorkspace(
				key,
				command.path,
				async (reply) => {
					await transport.replyText(message.messageId, reply);
				},
			);
			return true;
		}

		if (command.name === "workspace_list") {
			const data = await this.conversations.listWorkspaces(key);
			await transport.replyCard(
				message.messageId,
				buildWorkspaceListCard(data),
			);
			return true;
		}

		return false;
	}

	private isDuplicateContent(
		message: FeishuMessage,
		key: string,
		text: string,
		attachments: Array<{ kind: string; fileKey: string; fileName?: string }>,
	) {
		const now = Date.now();
		const attachmentKey = attachments
			.map((a) => `${a.kind}:${a.fileKey}:${a.fileName || ""}`)
			.join("|");
		const contentKey = [
			key,
			message.senderOpenId,
			normalizeForDedupe(text),
			attachmentKey,
		].join("\u0000");
		const previousContentAt = this.recentContent.get(contentKey);
		if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS)
			return true;
		this.recentContent.set(contentKey, now);
		if (this.recentContent.size > 2000)
			pruneRecentMap(this.recentContent, now, CONTENT_DEDUPE_TTL_MS);
		return false;
	}

	private async processAttachments(
		message: FeishuMessage,
		attachments: Array<{
			kind: "image" | "file";
			fileKey: string;
			fileName?: string;
		}>,
		modelSupportsImage: boolean,
	) {
		const transport = this.getTransport();
		const imageInputs: FeishuImageInput[] = [];
		const fileSections: string[] = [];
		const downloadErrors: string[] = [];
		let skippedImageCount = 0;

		for (const attachment of attachments) {
			if (attachment.kind === "image") {
				if (!modelSupportsImage) {
					skippedImageCount += 1;
					continue;
				}
				if (!transport) {
					downloadErrors.push(msg("handler.image.download_unavailable"));
					continue;
				}
				try {
					const resource = await withTimeout(
						transport.downloadImage(message.messageId, attachment.fileKey),
						15000,
						msg("handler.image.download_timeout"),
					);
					const mimeType = detectImageMime(resource.bytes, resource.mimeType);
					if (!isSupportedImageMime(mimeType)) {
						downloadErrors.push(msg("handler.image.unsupported_format"));
						continue;
					}
					imageInputs.push({
						type: "image",
						data: resource.bytes.toString("base64"),
						mimeType,
					});
				} catch (error) {
					debugLog("feishu.handler.image_error", {
						messageId: message.messageId,
						fileKey: attachment.fileKey,
						error: error instanceof Error ? error.message : String(error),
					});
					downloadErrors.push(
						error instanceof Error
							? error.message
							: msg("handler.image.download_failed"),
					);
				}
				continue;
			}

			const fileName = attachment.fileName || "unnamed";
			if (!isSupportedTextFile(fileName)) {
				downloadErrors.push(
					t("handler.file.unsupported_type", { name: fileName }),
				);
				continue;
			}
			if (!transport) {
				downloadErrors.push(
					t("handler.file.download_unavailable", { name: fileName }),
				);
				continue;
			}
			try {
				const resource = await withTimeout(
					transport.downloadMessageResource(
						message.messageId,
						attachment.fileKey,
						"file",
					),
					15000,
					t("handler.file.download_timeout", { name: fileName }),
				);
				const decoded = decodeTextFile(fileName, resource.bytes);
				if (!decoded.ok) {
					downloadErrors.push(t("handler.file.unreadable", { name: fileName }));
					continue;
				}
				const language = detectCodeLanguage(fileName);
				const suffix = decoded.truncated ? msg("handler.file.truncated") : "";
				fileSections.push(
					t("handler.file.section", {
						name: fileName,
						language,
						text: decoded.text,
					}) + suffix,
				);
			} catch (error) {
				downloadErrors.push(
					error instanceof Error
						? error.message
						: t("handler.file.download_failed", { name: fileName }),
				);
			}
		}

		return { imageInputs, fileSections, downloadErrors, skippedImageCount };
	}
}

function buildPrompt(
	message: FeishuMessage,
	text: string,
	fileSections: string[],
	imageInputs: FeishuImageInput[],
	skippedImageCount: number,
	modelSupportsImage: boolean,
	downloadErrors: string[],
) {
	const contentParts: string[] = [];
	if (text.trim()) contentParts.push(text.trim());
	if (fileSections.length) contentParts.push(fileSections.join("\n\n"));
	if (!contentParts.length && imageInputs.length) {
		contentParts.push(msg("handler.prompt.analyze_image"));
	}

	if (skippedImageCount > 0 && !modelSupportsImage) {
		contentParts.push(msg("handler.prompt.image_hint"));
	}

	if (downloadErrors.length) {
		contentParts.push(
			t("handler.prompt.attachment_errors", {
				errors: joinErrors(downloadErrors),
			}),
		);
	}

	const promptBody = contentParts.join("\n\n").trim();
	return `${conversationLabel(message)} ${promptBody}`;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
