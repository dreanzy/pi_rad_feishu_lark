import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	CardActionMode,
	Domain,
	FeishuConfig,
	GroupPolicy,
} from "./types.js";

export const ROOT_DIR = join(homedir(), ".pi", "agent", "feishu");
export const CONFIG_PATH = join(ROOT_DIR, "config.json");
export const STATE_PATH = join(ROOT_DIR, "state.json");
export const DEBUG_LOG_PATH = join(ROOT_DIR, "debug.log");
export const DAEMON_LOG_PATH = join(ROOT_DIR, "daemon.log");
export const DEDUPE_PATH = join(ROOT_DIR, "dedupe.json");
export const BRIDGE_PATH = join(ROOT_DIR, "bridge.json");
export const CHILD_SESSION_ENV = "PI_FEISHU_CHILD_SESSION";

export const DEFAULT_CONFIG: Pick<
	FeishuConfig,
	| "domain"
	| "groupPolicy"
	| "cardActionMode"
	| "cardActionWebhookHost"
	| "cardActionWebhookPort"
	| "cardActionWebhookPath"
	| "reactEmoji"
	| "autoStart"
	| "promptTimeoutMs"
	| "queueTimeoutMs"
	| "showStatusBar"
> = {
	domain: "feishu",
	groupPolicy: "open",
	cardActionMode: "webhook",
	cardActionWebhookHost: "0.0.0.0",
	cardActionWebhookPort: 3001,
	cardActionWebhookPath: "/webhook/card",
	reactEmoji: "THUMBSUP",
	autoStart: true,
	promptTimeoutMs: 180_000,
	queueTimeoutMs: 120_000,
	showStatusBar: true,
};

export function ensureRoot() {
	mkdirSync(ROOT_DIR, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		chmodSync(path, 0o600);
	} catch {}
}

export function removePath(path: string) {
	rmSync(path, { recursive: true, force: true });
}

export function loadConfig(): FeishuConfig | undefined {
	const envAppId = process.env.FEISHU_APP_ID?.trim();
	const envSecret = process.env.FEISHU_APP_SECRET?.trim();
	if (envAppId && envSecret) {
		return {
			appId: envAppId,
			appSecret: envSecret,
			domain: (process.env.FEISHU_DOMAIN as Domain) || DEFAULT_CONFIG.domain,
			groupPolicy:
				(process.env.FEISHU_GROUP_POLICY as GroupPolicy) ||
				DEFAULT_CONFIG.groupPolicy,
			cardActionMode:
				parseCardActionMode(process.env.FEISHU_CARD_ACTION_MODE) ||
				DEFAULT_CONFIG.cardActionMode,
			cardActionWebhookHost:
				process.env.FEISHU_CARD_ACTION_WEBHOOK_HOST?.trim() ||
				DEFAULT_CONFIG.cardActionWebhookHost,
			cardActionWebhookPort:
				parsePort(process.env.FEISHU_CARD_ACTION_WEBHOOK_PORT) ??
				DEFAULT_CONFIG.cardActionWebhookPort,
			cardActionWebhookPath:
				normalizeWebhookPath(process.env.FEISHU_CARD_ACTION_WEBHOOK_PATH) ||
				DEFAULT_CONFIG.cardActionWebhookPath,
			language:
				process.env.FEISHU_LANGUAGE === "zh"
					? "zh"
					: process.env.FEISHU_LANGUAGE === "en"
						? "en"
						: undefined,
			reactEmoji: process.env.FEISHU_REACT_EMOJI || DEFAULT_CONFIG.reactEmoji,
			autoStart: process.env.FEISHU_AUTO_START
				? process.env.FEISHU_AUTO_START !== "0"
				: DEFAULT_CONFIG.autoStart,
		};
	}
	if (!existsSync(CONFIG_PATH)) return undefined;
	const cfg = readJson<Partial<FeishuConfig>>(CONFIG_PATH, {});
	if (!cfg.appId || !cfg.appSecret) return undefined;
	return {
		appId: cfg.appId,
		appSecret: cfg.appSecret,
		domain: cfg.domain || DEFAULT_CONFIG.domain,
		groupPolicy: cfg.groupPolicy || DEFAULT_CONFIG.groupPolicy,
		cardActionMode:
			parseCardActionMode(cfg.cardActionMode) || DEFAULT_CONFIG.cardActionMode,
		cardActionWebhookHost:
			cfg.cardActionWebhookHost || DEFAULT_CONFIG.cardActionWebhookHost,
		cardActionWebhookPort:
			typeof cfg.cardActionWebhookPort === "number"
				? cfg.cardActionWebhookPort
				: DEFAULT_CONFIG.cardActionWebhookPort,
		cardActionWebhookPath:
			normalizeWebhookPath(cfg.cardActionWebhookPath) ||
			DEFAULT_CONFIG.cardActionWebhookPath,
		language:
			cfg.language === "zh" || cfg.language === "en" ? cfg.language : undefined,
		reactEmoji: cfg.reactEmoji || DEFAULT_CONFIG.reactEmoji,
		autoStart: cfg.autoStart ?? DEFAULT_CONFIG.autoStart,
		bashPath: cfg.bashPath,
		promptTimeoutMs:
			typeof cfg.promptTimeoutMs === "number"
				? cfg.promptTimeoutMs
				: DEFAULT_CONFIG.promptTimeoutMs,
		queueTimeoutMs:
			typeof cfg.queueTimeoutMs === "number"
				? cfg.queueTimeoutMs
				: DEFAULT_CONFIG.queueTimeoutMs,
		showStatusBar: cfg.showStatusBar ?? DEFAULT_CONFIG.showStatusBar,
	};
}

function parseCardActionMode(value: unknown): CardActionMode | undefined {
	if (value !== "webhook" && value !== "ws") return undefined;
	return value;
}

function parsePort(value: string | undefined) {
	if (!value) return undefined;
	const port = Number.parseInt(value, 10);
	if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
	return port;
}

function normalizeWebhookPath(value: string | undefined) {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Resolve the bash path for spawning the daemon process.
 * Priority (highest first):
 *   1. pifl config's bashPath
 *   2. Pi's shellPath setting (~/.pi/agent/settings.json, overridden by .pi/settings.json)
 *   3. "bash" (default fallback)
 */
export function getBashPath(config?: FeishuConfig): string {
	if (config?.bashPath) return config.bashPath;
	const piShellPath = getPiShellPath();
	if (piShellPath) return piShellPath;
	return "bash";
}

function getPiShellPath(): string | undefined {
	// Project-level overrides global-level
	const globalPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectPath = join(process.cwd(), ".pi", "settings.json");
	const globalSettings = readJson<Record<string, unknown>>(globalPath, {});
	const projectSettings = readJson<Record<string, unknown>>(projectPath, {});
	const shellPath = projectSettings.shellPath || globalSettings.shellPath;
	if (typeof shellPath === "string" && shellPath && isBashLike(shellPath))
		return shellPath;
	return undefined;
}

/**
 * Check whether a shell path is bash-compatible (supports -lc flag).
 * Filters out known non-bash shells like cmd, PowerShell, pwsh.
 * Pi's shellPath setting is documented for bash-compatible shells
 * (e.g., Cygwin on Windows), so unknown paths are assumed compatible.
 */
function isBashLike(path: string): boolean {
	const name = path.toLowerCase().replace(/\\/g, "/").split("/").pop() || "";
	if (
		name === "cmd" ||
		name === "cmd.exe" ||
		name === "powershell" ||
		name === "powershell.exe" ||
		name === "pwsh" ||
		name === "pwsh.exe"
	) {
		return false;
	}
	return true;
}

export function mask(s: string) {
	if (s.length <= 8) return "****";
	return `${s.slice(0, 4)}****${s.slice(-4)}`;
}
