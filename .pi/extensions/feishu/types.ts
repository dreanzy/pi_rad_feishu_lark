export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";
export type CardActionMode = "webhook" | "ws";

export type FeishuConfig = {
	appId: string;
	appSecret: string;
	domain: Domain;
	groupPolicy: GroupPolicy;
	cardActionMode?: CardActionMode;
	cardActionWebhookHost?: string;
	cardActionWebhookPort?: number;
	cardActionWebhookPath?: string;
	language?: "zh" | "en";
	reactEmoji?: string;
	autoStart?: boolean;
	/** LLM prompt timeout in milliseconds (default: 180000) */
	promptTimeoutMs?: number;
	/** Queue wait timeout in milliseconds (default: 120000) */
	queueTimeoutMs?: number;
	/** Custom bash path for spawning the daemon process.
	 * Highest priority; falls back to pi's shellPath setting, then "bash". */
	bashPath?: string;
	/** Show Feishu connection status in VSCode status bar (default: true) */
	showStatusBar?: boolean;
	/** Vision fallback: models used when current model doesn't support images */
	visionFallback?: {
		models: VisionFallbackModel[];
	};
};
export type VisionFallbackModel = string;

/** Parse "provider/model" or "provider/model:param" format */
export function parseVisionModel(entry: string): {
	provider: string;
	model: string;
	param?: string;
} {
	const colonIdx = entry.lastIndexOf(":");
	const slashIdx = entry.indexOf("/");
	if (slashIdx === -1) return { provider: "", model: entry };
	if (colonIdx > slashIdx) {
		return {
			provider: entry.slice(0, slashIdx),
			model: entry.slice(slashIdx + 1, colonIdx),
			param: entry.slice(colonIdx + 1),
		};
	}
	return {
		provider: entry.slice(0, slashIdx),
		model: entry.slice(slashIdx + 1),
	};
}

export type ModelSelection = {
	provider: string;
	id: string;
};

export type FeishuState = {
	sessions: Record<string, string>;
	models?: Record<string, ModelSelection>;
	workspaces?: Record<string, string>;
};

export type FeishuRoute = {
	sessionKey: string;
	sessionId?: string;
	chatId: string;
	chatType: "p2p" | "group";
	threadMessageId?: string;
	lastMessageId: string;
	updatedAt: number;
};

export type FeishuJobRoute = FeishuRoute & {
	jobId: string;
	jobName?: string;
	createdAt: number;
};

export type FeishuBridgeState = {
	version: 1;
	routes: Record<string, FeishuRoute>;
	jobs: Record<string, FeishuJobRoute>;
	sent: Record<string, number>;
};

export type FeishuMessage = {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	chatMode?: "p2p" | "group" | "topic";
	senderOpenId: string;
	msgType: string;
	content: string;
	rootId?: string;
	parentId?: string;
	threadId?: string;
	mentions?: unknown[];
};

export type FeishuAttachment = {
	kind: "image" | "file";
	fileKey: string;
	fileName?: string;
};

export type FeishuCardAction = {
	messageId: string;
	chatId?: string;
	operatorOpenId: string;
	token?: string;
	value: unknown;
	formValue?: Record<string, string>;
};

export type FeishuCopyMarkdownAction = {
	copySourceId: string;
};

export type FeishuStatus =
	| "not configured"
	| "connecting"
	| "connected"
	| "owned"
	| "bot unavailable"
	| "disconnected";
