import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
	AgentSession,
	SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FeishuBridgeRuntime } from "./bridge-runtime.js";
import {
	CHILD_SESSION_ENV,
	ensureRoot,
	loadConfig,
	readJson,
	STATE_PATH,
	writeJson,
} from "./config.js";
import { debugLog } from "./debug.js";
import type { ResumeScope, ResumeSessionPage } from "./cards.js";
import type { TaskStatusSink } from "./task-status-card.js";
import type { FeishuState } from "./types.js";
import { msg, t } from "./locale.js";

type ActiveRun = {
	session: AgentSession;
	runId?: string;
	stopped: boolean;
	status?: TaskStatusSink;
};

export type StopConversationResult =
	| { status: "stopped"; message: string }
	| { status: "not_running"; message: string }
	| { status: "stale"; message: string }
	| { status: "failed"; message: string };

const RESUME_PAGE_SIZE = 10;

export class ConversationManager {
	private readonly sessions = new Map<string, Promise<AgentSession>>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly activeRuns = new Map<string, ActiveRun>();
	private readonly authStorage = AuthStorage.create();
	private readonly modelRegistry = ModelRegistry.create(this.authStorage);
	private defaultProvider: string | undefined;
	private defaultModelId: string | undefined;
	private state: FeishuState;

	private readonly promptTimeoutMs: number;
	private readonly queueTimeoutMs: number;
	constructor(
		private readonly cwd: string,
		private readonly bridge?: FeishuBridgeRuntime,
	) {
		const cfg = loadConfig();
		this.promptTimeoutMs = cfg?.promptTimeoutMs ?? 180_000;
		this.queueTimeoutMs = cfg?.queueTimeoutMs ?? 120_000;
		ensureRoot();
		this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
		this.state.sessions ||= {};
		this.state.models ||= {};
		this.state.workspaces ||= {};
		this.loadSettingsDefault();
	}

	/** Read global settings default model for fallback in getSelectedModel. */
	private loadSettingsDefault() {
		try {
			const settingsPath = join(getAgentDir(), "settings.json");
			const raw = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(raw);
			if (settings.defaultProvider && settings.defaultModel) {
				this.defaultProvider = settings.defaultProvider;
				this.defaultModelId = settings.defaultModel;
			}
		} catch {}
	}

	async prompt(
		key: string,
		userText: string,
		onReply: (text: string) => Promise<void>,
	) {
		return this.promptWithImages(key, userText, [], onReply);
	}

	async promptWithImages(
		key: string,
		userText: string,
		images: Array<{ type: "image"; data: string; mimeType: string }>,
		onReply: (text: string) => Promise<void>,
		status?: TaskStatusSink,
	) {
		const previous = this.previousTurn(key);
		const next = previous
			.then(async () => {
				debugLog("feishu.prompt.start", {
					key,
					textLength: userText.length,
					imageCount: images.length,
				});
				const session = await this.getSession(key);
				const run: ActiveRun = {
					session,
					runId: status?.runId,
					stopped: false,
					status,
				};
				this.activeRuns.set(key, run);
				this.bridge?.beginFeishuInput(session.sessionId);
				try {
					try {
						await withTimeout(
							session.prompt(userText, images.length ? { images } : undefined),
							this.promptTimeoutMs,
							msg("conversation.timeout"),
						);
					} catch (error) {
						if (run.stopped) {
							debugLog("feishu.prompt.stopped", { key });
							return;
						}
						throw error;
					}
				} finally {
					if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
					this.bridge?.endFeishuInput(session.sessionId);
				}
				if (run.stopped) return;
				const answer = extractLastAssistantText(session);
				debugLog("feishu.prompt.done", { key, answerLength: answer.length });
				await onReply(answer || "No response.");
				await status?.finish("done");
			})
			.catch(async (error) => {
				const message = error instanceof Error ? error.message : String(error);
				debugLog("feishu.prompt.error", { key, error: message });
				await status?.finish("failed", message);
				await onReply(`Pi error: ${message}`);
			});
		this.queues.set(key, next);
		await next;
	}

	async stopConversation(
		key: string,
		onReply: (text: string) => Promise<void>,
		runId?: string,
	): Promise<StopConversationResult> {
		const active = this.activeRuns.get(key);
		if (!active) {
			const message = msg("conversation.not_running");
			await onReply(message);
			return { status: "not_running", message };
		}
		if (runId && active.runId && active.runId !== runId) {
			const message = msg("conversation.stale_card");
			await onReply(message);
			debugLog("feishu.prompt.stop_stale", {
				key,
				runId,
				activeRunId: active.runId,
			});
			return { status: "stale", message };
		}

		active.stopped = true;
		await active.status?.stopImmediately(msg("conversation.user_stopped"));
		try {
			await active.session.abort();
			debugLog("feishu.prompt.abort", { key });
			const message = msg("conversation.stopped");
			await onReply(message);
			return { status: "stopped", message };
		} catch (error) {
			active.stopped = false;
			debugLog("feishu.prompt.abort_error", {
				key,
				error: error instanceof Error ? error.message : String(error),
			});
			const message = msg("conversation.stop_failed");
			await onReply(message);
			return { status: "failed", message };
		}
	}

	async newConversation(key: string, onReply: (text: string) => Promise<void>) {
		const previous = this.previousTurn(key);
		const next = previous
			.then(async () => {
				const cached = this.sessions.get(key);
				if (cached) {
					try {
						(await cached).dispose();
					} catch {}
				}
				this.sessions.delete(key);
				delete this.state.sessions[key];
				writeJson(STATE_PATH, this.state);
				await onReply(msg("conversation.new_created"));
			})
			.catch(async (error) => {
				await onReply(
					`Pi error: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		this.queues.set(key, next);
		await next;
	}

	async listResumeSessions(
		key: string,
		scope: ResumeScope,
		page: number,
	): Promise<ResumeSessionPage> {
		const sessions = await this.getResumeSessions(key, scope);
		const normalizedPage = Math.max(0, Math.floor(page));
		const total = sessions.length;
		const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
		const clampedPage = Math.min(normalizedPage, totalPages - 1);
		const currentSessionPath = this.normalizeSessionPath(
			this.state.sessions[key],
		);
		const start = clampedPage * RESUME_PAGE_SIZE;
		const items = sessions
			.slice(start, start + RESUME_PAGE_SIZE)
			.map((session) => {
				const sessionPath =
					this.normalizeSessionPath(session.path) || session.path;
				return {
					path: session.path,
					title:
						session.name?.trim() || summarizeFirstMessage(session.firstMessage),
					subtitle: session.name?.trim()
						? summarizeFirstMessage(session.firstMessage)
						: t("conversation.message_count", { count: session.messageCount }),
					modifiedLabel: formatModifiedLabel(session.modified),
					workspaceLabel:
						scope === "all" ? formatWorkspaceLabel(session.cwd) : undefined,
					isCurrent: Boolean(
						currentSessionPath &&
							sessionPath &&
							currentSessionPath === sessionPath,
					),
				};
			});

		return {
			key,
			scope,
			page: clampedPage,
			total,
			totalPages,
			items,
		};
	}

	async resumeConversation(
		key: string,
		sessionPathInput: string,
		onReply: (text: string) => Promise<void>,
	) {
		if (this.activeRuns.has(key)) {
			await onReply(msg("conversation.busy_resume"));
			return;
		}

		const previous = this.previousTurn(key);
		const next = previous
			.then(async () => {
				const sessionPath = this.normalizeExistingSessionPath(sessionPathInput);
				const sessionInfo = await this.findSessionInfo(sessionPath);
				if (!sessionInfo) {
					await onReply(msg("conversation.not_found"));
					return;
				}

				const currentPath = this.normalizeSessionPath(this.state.sessions[key]);
				if (currentPath === sessionPath) {
					this.state.workspaces![key] =
						sessionInfo.cwd || this.getWorkspace(key);
					writeJson(STATE_PATH, this.state);
					await onReply(
						`${msg("conversation.already_in")}\n${t("conversation.current_workspace", { path: this.state.workspaces![key] })}`,
					);
					return;
				}

				const cached = this.sessions.get(key);
				if (cached) {
					try {
						(await cached).dispose();
					} catch {}
				}

				this.sessions.delete(key);
				this.state.sessions[key] = sessionPath;
				this.state.workspaces![key] = sessionInfo.cwd || this.cwd;
				writeJson(STATE_PATH, this.state);
				await onReply(
					[
						t("conversation.switched_session", {
							name:
								sessionInfo.name?.trim() ||
								summarizeFirstMessage(sessionInfo.firstMessage),
						}),
						t("conversation.workspace_label", {
							path: this.state.workspaces![key],
						}),
						msg("conversation.next_message"),
					].join("\n"),
				);
			})
			.catch(async (error) => {
				await onReply(
					`Pi error: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		this.queues.set(key, next);
		await next;
	}

	async selectModel(
		key: string,
		provider: string,
		modelId: string,
		onReply: (text: string) => Promise<void>,
	) {
		const previous = this.previousTurn(key);
		const next = previous
			.then(async () => {
				const model = this.modelRegistry.find(provider, modelId);
				if (!model || !this.modelRegistry.hasConfiguredAuth(model)) {
					await onReply(
						t("conversation.model_unavailable", {
							model: `${provider}/${modelId}`,
						}),
					);
					return;
				}

				this.state.models![key] = { provider, id: modelId };
				writeJson(STATE_PATH, this.state);

				const cached = this.sessions.get(key);
				if (cached) {
					try {
						(await cached).dispose();
					} catch {}
				}
				this.sessions.delete(key);
				await onReply(
					t("conversation.model_switched", { model: `${provider}/${modelId}` }),
				);
			})
			.catch(async (error) => {
				await onReply(
					`Pi error: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		this.queues.set(key, next);
		await next;
	}

	getWorkspace(key: string) {
		return this.state.workspaces?.[key] || this.cwd;
	}

	async listWorkspaces(key: string) {
		const allSessions = await SessionManager.listAll();
		const workspaceSet = new Set<string>();
		for (const session of allSessions) {
			if (session.cwd) workspaceSet.add(session.cwd);
		}
		// Also include workspaces tracked in state
		for (const ws of Object.values(this.state.workspaces || {})) {
			if (ws) workspaceSet.add(ws);
		}
		const currentPath = this.getWorkspace(key);
		const items = [...workspaceSet]
			.sort((a, b) => a.localeCompare(b))
			.map((path) => ({
				path,
				label: basename(path),
				isCurrent: path === currentPath,
			}));
		return { key, items } as import("./cards.js").WorkspaceListData;
	}

	async switchWorkspace(
		key: string,
		workspaceInput: string | undefined,
		onReply: (text: string) => Promise<void>,
	) {
		if (!workspaceInput) {
			const current = this.getWorkspace(key);
			await onReply(
				[
					t("conversation.workspace_current", { path: current }),
					msg("conversation.workspace_usage"),
					msg("conversation.workspace_tilde"),
				].join("\n"),
			);
			return;
		}

		const previous = this.previousTurn(key);
		const next = previous
			.then(async () => {
				const workspace = resolveWorkspacePath(workspaceInput);
				const cached = this.sessions.get(key);
				if (cached) {
					try {
						(await cached).dispose();
					} catch {}
				}
				this.sessions.delete(key);
				delete this.state.sessions[key];
				this.state.workspaces![key] = workspace;
				writeJson(STATE_PATH, this.state);
				await onReply(
					`${t("conversation.workspace_switched", { path: workspace })}\n${msg("conversation.workspace_next")}`,
				);
			})
			.catch(async (error) => {
				await onReply(
					error instanceof Error ? error.message : `Pi error: ${String(error)}`,
				);
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
		// Check settings default model before falling back to first available
		if (this.defaultProvider && this.defaultModelId) {
			const defaultModel = this.modelRegistry.find(
				this.defaultProvider,
				this.defaultModelId,
			);
			if (defaultModel && this.modelRegistry.hasConfiguredAuth(defaultModel)) {
				return defaultModel;
			}
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
		this.state = { sessions: {}, models: {}, workspaces: {} };
	}

	private getSession(key: string): Promise<AgentSession> {
		const cached = this.sessions.get(key);
		if (cached) return cached;
		const created = this.createSession(key);
		this.sessions.set(key, created);
		return created;
	}

	private previousTurn(key: string) {
		const previous = this.queues.get(key) || Promise.resolve();
		return withTimeout(
			previous,
			this.queueTimeoutMs,
			msg("conversation.queue_timeout"),
		).catch((error) => {
			debugLog("feishu.queue.previous_timeout", {
				key,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private async createSession(key: string): Promise<AgentSession> {
		const workspaceCwd = this.getWorkspace(key);
		ensureWorkspaceExists(workspaceCwd);
		const existingFile = this.state.sessions[key];
		const selected = this.state.models?.[key];
		const model = selected
			? this.modelRegistry.find(selected.provider, selected.id)
			: undefined;
		const sessionManager =
			existingFile && existsSync(existingFile)
				? SessionManager.open(existingFile, undefined, workspaceCwd)
				: SessionManager.create(workspaceCwd);

		const loader = new DefaultResourceLoader({
			cwd: workspaceCwd,
			agentDir: getAgentDir(),
			systemPromptOverride: (base) => {
				const extra =
					"You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
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
			cwd: workspaceCwd,
			agentDir: getAgentDir(),
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			model,
			sessionManager,
			resourceLoader: loader,
		});

		await session.bindExtensions({});
		this.bridge?.attachSession(key, session.sessionId);
		session.subscribe((event) => {
			this.activeRuns.get(key)?.status?.updateFromEvent(event);
			if (event.type === "message_end") {
				this.bridge?.handleMessageEnd(session.sessionId, key, event.message);
			}
		});

		if (
			session.sessionFile &&
			this.state.sessions[key] !== session.sessionFile
		) {
			this.state.sessions[key] = session.sessionFile;
			writeJson(STATE_PATH, this.state);
		}
		return session;
	}

	private async getResumeSessions(key: string, scope: ResumeScope) {
		const base =
			scope === "all"
				? await SessionManager.listAll()
				: await SessionManager.list(this.getWorkspace(key));
		return [...base].sort(
			(a, b) => toTimeMs(b.modified) - toTimeMs(a.modified),
		);
	}

	private async findSessionInfo(
		sessionPath: string,
	): Promise<SessionInfo | undefined> {
		const currentWorkspace = this.getWorkspaceFromSessionFile(sessionPath);
		const localSessions = currentWorkspace
			? await SessionManager.list(currentWorkspace)
			: [];
		const normalizedTarget = this.normalizeSessionPath(sessionPath);
		const fromLocal = localSessions.find(
			(item) => this.normalizeSessionPath(item.path) === normalizedTarget,
		);
		if (fromLocal) return fromLocal;
		const allSessions = await SessionManager.listAll();
		return allSessions.find(
			(item) => this.normalizeSessionPath(item.path) === normalizedTarget,
		);
	}

	private getWorkspaceFromSessionFile(sessionPath: string) {
		try {
			return SessionManager.open(sessionPath).getCwd();
		} catch {
			return undefined;
		}
	}

	private normalizeExistingSessionPath(path: string) {
		if (!path || !existsSync(path)) {
			throw new Error(msg("conversation.not_found_deleted"));
		}
		return realpathSync(path);
	}

	private normalizeSessionPath(path: string | undefined) {
		if (!path) return undefined;
		try {
			return existsSync(path) ? realpathSync(path) : path;
		} catch {
			return path;
		}
	}
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

function extractLastAssistantText(session: AgentSession): string {
	const messages = [...(session.messages || [])].reverse();
	for (const msg of messages as any[]) {
		if (msg.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.map((p) => (p?.type === "text" ? p.text : ""))
				.join("")
				.trim();
		}
	}
	return "";
}

function resolveWorkspacePath(input: string) {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error(msg("conversation.workspace_usage_detail"));
	}

	const expanded =
		trimmed === "~" || trimmed.startsWith("~/")
			? join(homedir(), trimmed.slice(2))
			: trimmed;

	if (!isAbsolute(expanded)) {
		throw new Error(msg("conversation.workspace_absolute_only"));
	}

	const resolved = resolve(expanded);
	ensureWorkspaceExists(resolved);
	return realpathSync(resolved);
}

function ensureWorkspaceExists(path: string) {
	if (!existsSync(path)) {
		throw new Error(t("conversation.workspace_not_exist", { path }));
	}

	let stat;
	try {
		stat = statSync(path);
	} catch {
		throw new Error(t("conversation.workspace_not_accessible", { path }));
	}

	if (!stat.isDirectory()) {
		throw new Error(t("conversation.workspace_not_dir", { path }));
	}
}

function summarizeFirstMessage(text: string) {
	const normalized = (text || "").replace(/\s+/g, " ").trim();
	if (!normalized) return msg("conversation.unnamed_session");
	return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}

function formatModifiedLabel(value: Date | string) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return msg("conversation.unknown_date");
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	const hh = String(date.getHours()).padStart(2, "0");
	const min = String(date.getMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatWorkspaceLabel(cwd: string) {
	if (!cwd) return "(unknown)";
	return `${basename(cwd)} · ${cwd}`;
}

function toTimeMs(value: Date | string) {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
