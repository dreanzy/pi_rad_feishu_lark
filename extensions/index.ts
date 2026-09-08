import { existsSync, openSync, readFileSync } from "node:fs";
import { execSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	buildModelCard,
	buildResumeCard,
	buildWorkspaceListCard,
	parseModelActionValue,
	parseResumePageActionValue,
	parseResumeSelectActionValue,
	parseWorkspaceSelectActionValue,
} from "./cards.js";
import {
	buildSkillListCard,
	parseSkillDirectActionValue,
	parseSkillPageActionValue,
	parseSkillParamActionValue,
} from "./skills-card.js";
import {
	BRIDGE_PATH,
	CHILD_SESSION_ENV,
	CONFIG_PATH,
	DAEMON_LOG_PATH,
	DEBUG_LOG_PATH,
	DEDUPE_PATH,
	ensureRoot,
	getBashPath,
	loadConfig,
	mask,
	readJson,
	removePath,
	STATE_PATH,
	writeJson,
} from "./config.js";
import { debugLog } from "./debug.js";
import { sleep, withFileLock } from "./utils.js";
import { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { FeishuBridgeStore } from "./bridge-store.js";
import { ConversationManager } from "./conversation-manager.js";
import { FeishuDelivery } from "./delivery.js";
import {
	acquireGatewayLock,
	gatewayLockPath,
	readGatewayOwner,
	type GatewayLockHandle,
	type GatewayOwner,
} from "./gateway-lock.js";
import {
	FeishuMessageHandler,
	SUMMARIZE_IMAGES_ACTION,
} from "./message-handler.js";
import { runSetup, uiConfirm } from "./setup.js";
import {
	buildTaskStatusCard,
	parseStopTaskActionValue,
} from "./task-status-card.js";
import { BotUnavailableError, FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuStatus } from "./types.js";
import { invalidateLocale, msg, t } from "./locale.js";
import {
	checkModels,
	formatInvalidSummary,
	type CheckRegistry,
	type RegistryModelLike,
} from "./model-check.js";

export default async function feishuExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_SESSION_ENV] === "1") {
		return;
	}

	let transport: FeishuTransport | undefined;
	let gatewayLock: GatewayLockHandle | undefined;
	const bridgeStore = new FeishuBridgeStore();
	const modelRuntimeFactory = () =>
		ModelRuntime.create({ authPath: join(getAgentDir(), "auth.json") });

	const delivery = new FeishuDelivery(() => transport);
	const bridge = new FeishuBridgeRuntime(bridgeStore, delivery);
	const conversations = new ConversationManager(
		process.cwd(),
		modelRuntimeFactory,
		bridge,
	);
	const messageHandler = new FeishuMessageHandler(
		conversations,
		() => transport,
		bridgeStore,
	);

	const STATUS_KEY = "feishu-connection";
	const STATUS_REFRESH_MS = 2_000;
	let uiRef:
		| { setStatus?: (key: string, text: string | undefined) => void }
		| undefined;
	let lastStatusText: string | undefined;
	let statusRefreshTimer: NodeJS.Timeout | undefined;
	const buildTag = process.env.FEISHU_EXT_DEV === "1" ? " [DEV]" : "";

	function setStatusText(text: string | undefined) {
		if (lastStatusText === text) return;
		lastStatusText = text;
		const cfg = loadConfig();
		if (cfg?.showStatusBar === false) {
			uiRef?.setStatus?.(STATUS_KEY, undefined);
			return;
		}
		uiRef?.setStatus?.(STATUS_KEY, text);
	}

	function updateStatus(status: FeishuStatus) {
		const cfg = loadConfig();
		const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
		setStatusText(statusText(brand, status));
	}

	function withBuildTag(text: string) {
		return `${text}${buildTag}`;
	}

	function statusText(brand: "Feishu" | "Lark", status: FeishuStatus) {
		const labels: Record<FeishuStatus, string> = {
			"not configured": msg("status.not_configured"),
			connecting: msg("status.connecting"),
			connected: msg("status.connected"),
			disconnected: msg("status.disconnected"),
			owned: msg("status.owned"),
			"bot unavailable": msg("status.bot_unavailable"),
		};
		return withBuildTag(`${brand}: ${labels[status]}`);
	}

	function refreshStatusFromState() {
		const cfg = loadConfig();
		const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
		if (!cfg) {
			setStatusText(statusText(brand, "not configured"));
			return;
		}
		if (transport?.isRunning()) {
			setStatusText(statusText(brand, "connected"));
			return;
		}
		const owner = readGatewayOwner();
		if (owner?.status === "connected") {
			setStatusText(statusText(brand, "connected"));
		} else if (owner?.status === "starting") {
			setStatusText(statusText(brand, "connecting"));
		} else if (owner) {
			setStatusText(statusText(brand, "disconnected"));
		} else {
			setStatusText(statusText(brand, "disconnected"));
		}
	}

	function startStatusRefresh() {
		if (statusRefreshTimer) return;
		refreshStatusFromState();
		statusRefreshTimer = setInterval(refreshStatusFromState, STATUS_REFRESH_MS);
		statusRefreshTimer.unref?.();
	}

	function stopStatusRefresh() {
		if (!statusRefreshTimer) return;
		clearInterval(statusRefreshTimer);
		statusRefreshTimer = undefined;
	}

	function clearStatus() {
		stopStatusRefresh();
		lastStatusText = undefined;
		uiRef?.setStatus?.(STATUS_KEY, undefined);
	}

	pi.on("message_end", async (event, ctx) => {
		bridge.handleMessageEnd(
			ctx.sessionManager.getSessionId(),
			undefined,
			event.message,
		);
	});

	async function start(
		config?: FeishuConfig,
		options: { takeover?: boolean } = {},
	) {
		if (transport?.isRunning()) {
			updateStatus("connected");
			return "already";
		}
		const cfg = config || loadConfig();
		if (!cfg) {
			updateStatus("not configured");
			throw new Error(msg("status.missing_config"));
		}
		updateStatus("connecting");
		const lockResult = await acquireGatewayLock(
			process.cwd(),
			Boolean(options.takeover),
		);
		if (lockResult.status === "busy") {
			updateStatus("owned");
			return { status: "owned" as const, owner: lockResult.owner };
		}
		gatewayLock = lockResult.handle;
		gatewayLock.setOnLost(async () => {
			await transport?.stop();
			transport = undefined;
			gatewayLock = undefined;
			updateStatus(loadConfig() ? "owned" : "not configured");
			// Daemon lost ownership — kill launcher parent then exit
			if (process.env.PI_FEISHU_DAEMON === "1") {
				const ppid = process.ppid;
				if (ppid && ppid > 1 && ppid !== process.pid) {
					try {
						process.kill(ppid, "SIGTERM");
					} catch {
						try {
							execSync(`taskkill /F /T /PID ${ppid}`, {
								timeout: 3000,
								windowsHide: true,
								// Pipe stderr to avoid leaking localized (GBK) error text
								// straight to the TUI terminal as mojibake.
								stdio: ["ignore", "pipe", "pipe"],
							});
						} catch {}
					}
				}
				process.exit(0);
			}
		});
		transport = new FeishuTransport(
			cfg,
			(msg) => messageHandler.handle(msg),
			async (action) => {
				const copy = parseCopyMarkdownActionValue(action.value);
				if (copy) {
					const source = transport?.getMarkdownCopySource(copy.copySourceId);
					await transport?.replyPlainText(
						action.messageId,
						source || msg("card.copy.stale"),
					);
					return;
				}
				const stopTask = parseStopTaskActionValue(action.value);
				if (stopTask) {
					debugLog("feishu.card.stop_requested", {
						key: stopTask.key,
						runId: stopTask.runId,
						cardMessageId: action.messageId,
						chatId: action.chatId,
					});
					const result = await conversations.stopConversation(
						stopTask.key,
						async (reply) => {
							await transport?.replyText(action.messageId, reply);
						},
						stopTask.runId,
					);
					const status =
						result.status === "stopped"
							? "stopped"
							: result.status === "failed"
								? "failed"
								: "inactive";
					debugLog("feishu.card.stop_final_update_done", {
						key: stopTask.key,
						runId: stopTask.runId,
						cardMessageId: action.messageId,
						result: result.status,
					});
					return buildTaskStatusCard({
						key: stopTask.key,
						runId: stopTask.runId,
						status,
						phase: result.message,
					});
				}
				const summarize = parseSummarizeImagesActionValue(action.value);
				if (summarize) {
					const pendingImages = conversations.takePendingImages(summarize.key);
					if (!pendingImages.length) {
						await transport?.replyText(
							action.messageId,
							msg("handler.image.no_pending"),
						);
						return;
					}
					const visionModels = loadConfig()?.visionFallback?.models;
					if (!visionModels?.length) {
						await transport?.replyText(
							action.messageId,
							msg("handler.image.unsupported_model"),
						);
						return;
					}
					const result = await conversations.promptVisionFallback(
						"",
						pendingImages,
						visionModels,
					);
					if (result) {
						await transport?.replyText(action.messageId, result.description);
					} else {
						await transport?.replyText(
							action.messageId,
							msg("handler.image.vision_fallback_failed"),
						);
					}
					return;
				}
				const resumePage = parseResumePageActionValue(action.value);
				if (resumePage) {
					const page = await conversations.listResumeSessions(
						resumePage.key,
						resumePage.scope,
						resumePage.page,
					);
					return buildResumeCard(page);
				}
				const resumeSelect = parseResumeSelectActionValue(action.value);
				if (resumeSelect) {
					await conversations.resumeConversation(
						resumeSelect.key,
						resumeSelect.sessionPath,
						async (reply) => {
							await transport?.replyText(action.messageId, reply);
						},
					);
					const page = await conversations.listResumeSessions(
						resumeSelect.key,
						resumeSelect.scope,
						resumeSelect.page,
					);
					return buildResumeCard(page);
				}
				const workspaceSelect = parseWorkspaceSelectActionValue(action.value);
				if (workspaceSelect) {
					const { key: wsKey, path: wsPath } = workspaceSelect;
					await conversations.switchWorkspace(wsKey, wsPath, async (reply) => {
						await transport?.replyText(action.messageId, reply);
					});
					const data = await conversations.listWorkspaces(wsKey);
					return buildWorkspaceListCard(data);
				}
				const skillPage = parseSkillPageActionValue(action.value);
				if (skillPage) {
					const result = await conversations.listSkills();
					const totalPages = Math.max(1, Math.ceil(result.length / 6));
					const start = skillPage.page * 6;
					const items = result.slice(start, start + 6).map((s) => ({
						name: s.name,
						description: s.description,
					}));
					return buildSkillListCard({
						key: skillPage.key,
						page: skillPage.page,
						total: result.length,
						totalPages,
						items,
					});
				}

				const skillDirect = parseSkillDirectActionValue(action.value);
				if (skillDirect) {
					await transport?.replyText(
						action.messageId,
						`⏳ 正在使用 Skill「${skillDirect.skillName}」...`,
					);
					conversations
						.useSkill(
							skillDirect.key,
							skillDirect.skillName,
							undefined,
							async (reply) => {
								await transport?.replyText(action.messageId, reply);
							},
						)
						.catch(() => {});
					return;
				}

				const skillParam = parseSkillParamActionValue(action.value);
				if (skillParam) {
					conversations.setPendingSkillParam(skillParam.key, skillParam.skillName);
					await transport?.replyText(
						action.messageId,
						`请发送您想让 Skill「${skillParam.skillName}」处理的参数内容`,
					);
					return;
				}

				const selected = parseModelActionValue(action.value);
				if (!selected) return;
				await conversations.selectModel(
					selected.key,
					selected.provider,
					selected.modelId,
					async (reply) => {
						await transport?.replyText(action.messageId, reply);
					},
				);
				const models = await conversations.getAvailableModels();
				const currentModel = await conversations.getSelectedModel(selected.key);
				return buildModelCard(selected.key, models, currentModel);
			},
		);
		try {
			await transport.start();
			gatewayLock.startHeartbeat();
			await gatewayLock.update("connected");
			updateStatus("connected");
			// Pre-warm the model runtime off the connection path so the first
			// message doesn't pay the ModelRuntime.create cost.
			conversations.warmup();
			return "started";
		} catch (error) {
			updateStatus(
				error instanceof BotUnavailableError ? "bot unavailable" : "disconnected",
			);
			await gatewayLock.release();
			gatewayLock = undefined;
			transport = undefined;
			throw error;
		}
	}

	async function stop() {
		await transport?.stop();
		transport = undefined;
		await gatewayLock?.release();
		gatewayLock = undefined;
		updateStatus(loadConfig() ? "disconnected" : "not configured");
	}

	function formatOwner(owner: GatewayOwner | undefined) {
		if (!owner) return "none";
		return `pid=${owner.pid}, status=${owner.status}`;
	}

	function notifyDaemonStartResult(
		ctx: any,
		result: Awaited<ReturnType<typeof startDaemon>>,
	) {
		if (result.status === "busy") {
			notifyInfo(
				ctx,
				withBuildTag(
					t("notify.daemon_already_running", {
						pid: result.owner?.pid ?? "?",
					}),
				),
			);
			return;
		}
		notifyInfo(
			ctx,
			withBuildTag(
				t("notify.daemon_started", { pid: result.pid, path: DAEMON_LOG_PATH }),
			),
		);
	}

	function piCliPath(): string {
		if (process.env.PI_BIN) return process.env.PI_BIN;
		// Find pi's CLI script via package resolution
		try {
			const req = createRequire(import.meta.url);
			const pkgPath = req.resolve("@earendil-works/pi-coding-agent/package.json");
			// Use the self-contained bundle entry (npm bin target). The unbundled
			// dist/cli.js imports @earendil-works/pi-server at load, which the
			// published package only lists as a devDependency — crashing the
			// daemon on pi >= 0.85 with ERR_MODULE_NOT_FOUND.
			return join(dirname(pkgPath), "dist", "bundle", "cli.js");
		} catch {
			// Fallback: npm global install path
			const npmDir = join(process.env.APPDATA || "", "npm");
			return join(
				npmDir,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				"bundle",
				"cli.js",
			);
		}
	}

	function daemonSpec() {
		const extensionPath = fileURLToPath(import.meta.url);
		return [
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
			"-e",
			extensionPath,
		];
	}

	function quoteShell(value: string) {
		return `'${value.replace(/'/g, `'\\''`)}'`;
	}

	/**
	 * Daemon command with a keep-alive stdin pipe.
	 *
	 * pi's RPC mode shuts down when stdin hits EOF. If we spawn the daemon
	 * with a plain pipe, the pipe write end lives in the TUI process — closing
	 * the TUI (or ending its session) closes the pipe, the daemon sees EOF and
	 * exits, killing the Feishu connection.
	 *
	 * `tail -f /dev/null |` keeps the daemon's stdin open forever, owned by the
	 * detached bash process instead of the TUI, so the daemon survives TUI
	 * close/restart. The bash launcher is reaped via reapDetachedDaemonProcesses.
	 */
	function daemonCommand() {
		const args = daemonSpec();
		// Node/CLI paths need forward slashes for bash; args (incl. extensionPath)
		// stay as-is in single quotes so reap's looksLikeFeishuDaemon can match
		// the Windows path verbatim.
		const nodeBin = process.execPath.replace(/\\/g, "/");
		const cli = piCliPath().replace(/\\/g, "/");
		return `tail -f /dev/null | exec ${quoteShell(nodeBin)} ${quoteShell(cli)} ${args
			.map(quoteShell)
			.join(" ")}`;
	}

	async function startDaemon(takeover = false) {
		return withDaemonSpawnLock(async () => {
			const cfg = loadConfig();
			if (!cfg) throw new Error(msg("status.missing_config"));
			let owner = readGatewayOwner();
			if (owner && owner.pid !== process.pid && !takeover) {
				return { status: "busy" as const, owner };
			}

			if (owner?.pid === process.pid || transport?.isRunning()) {
				await stop();
			} else if (owner && takeover) {
				try {
					process.kill(owner.pid, "SIGTERM");
				} catch {}
				await sleep(800);
			}

			// Re-check while holding the spawn lock. Another TUI may have started it
			// while this process was waiting for the lock.
			owner = readGatewayOwner();
			if (owner && owner.pid !== process.pid && !takeover) {
				return { status: "busy" as const, owner };
			}

			reapDetachedDaemonProcesses({ keepPids: [process.pid] });
			ensureRoot();
			const logFd = openSync(DAEMON_LOG_PATH, "a");
			const child = spawn(getBashPath(cfg), ["-lc", daemonCommand()], {
				detached: true,
				windowsHide: true,
				cwd: process.cwd(),
				env: { ...process.env, PI_FEISHU_DAEMON: "1" },
				stdio: ["ignore", logFd, logFd],
			});
			const spawnFailed = new Promise<never>((_, reject) =>
				child.on("error", reject),
			);
			child.unref();

			// Wait for spawn to succeed or the daemon to start
			const timeout = sleep(1500);
			const result = await Promise.race([spawnFailed, timeout]);
			if (result === undefined && !child.pid) {
				throw new Error("Failed to start daemon process");
			}
			return {
				status: "started" as const,
				pid: readGatewayOwner()?.pid ?? child.pid!,
				owner: readGatewayOwner(),
			};
		});
	}

	async function stopDaemon() {
		const owner = readGatewayOwner();
		if (!owner) {
			reapDetachedDaemonProcesses();
			return { status: "none" as const };
		}
		if (owner.pid === process.pid) {
			await stop();
			reapDetachedDaemonProcesses({ keepPids: [process.pid] });
			return { status: "stopped-current" as const };
		}
		try {
			if (process.platform === "win32") {
				killDaemonParentWindows(owner.pid);
			} else {
				process.kill(owner.pid, "SIGTERM");
			}
			await sleep(800);
			return { status: "stopped" as const, owner };
		} catch (error) {
			return { status: "error" as const, owner, error };
		} finally {
			reapDetachedDaemonProcesses();
		}
	}

	async function restartDaemon() {
		const stopped = await stopDaemon();
		if (stopped.status === "error") return { status: "error" as const, stopped };
		const started = await startDaemon(true);
		return { status: "restarted" as const, stopped, started };
	}

	// Strip non-ASCII for TUI display (CP936 terminal + UTF-8 + ANSI dim = garbled)
	function tuiSafe(text: string): string {
		return text.replace(/[^\x20-\x7E\n\r\t]/g, "?");
	}

	function notifyError(ctx: any, error: unknown) {
		ctx.ui.notify(
			tuiSafe(error instanceof Error ? error.message : String(error)),
			"error",
		);
	}

	function notifyInfo(ctx: any, text: string) {
		ctx.ui.notify(tuiSafe(text), "info");
	}

	function registerFeishuCmd(
		name: string,
		description: string,
		fn: (ctx: any) => Promise<void>,
	) {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx) => {
				uiRef = ctx.ui as any;
				try {
					await fn(ctx);
				} catch (error) {
					notifyError(ctx, error);
				}
			},
		});
	}

	registerFeishuCmd(
		"feishu-setup",
		"交互式配置 Feishu/Lark 应用",
		async (ctx) => {
			const configToStart = await runSetup(ctx);
			if (configToStart) {
				writeJson(CONFIG_PATH, configToStart);
				invalidateLocale();
				notifyDaemonStartResult(ctx, await startDaemon(false));
			}
			refreshStatusFromState();
		},
	);

	registerFeishuCmd("feishu-start", "启动 Feishu/Lark 守护进程", async (ctx) => {
		notifyDaemonStartResult(ctx, await startDaemon(false));
		refreshStatusFromState();
	});

	registerFeishuCmd("feishu-stop", "停止 Feishu/Lark 守护进程", async (ctx) => {
		const result = await stopDaemon();
		if (result.status === "error") {
			ctx.ui.notify(
				tuiSafe(
					t("notify.stop_failed", {
						error:
							result.error instanceof Error
								? result.error.message
								: String(result.error),
						pid: result.owner?.pid ?? "?",
					}),
				),
				"error",
			);
			refreshStatusFromState();
			return;
		}
		// Defer TUI interactions to let Pi's progress bar render fully first.
		// ponytail: race between "/r" progress bar and notify/status update.
		await sleep(0);
		updateStatus("disconnected");
		notifyInfo(
			ctx,
			result.status === "none" ? msg("notify.not_running") : msg("notify.stopped"),
		);
		refreshStatusFromState();
	});

	registerFeishuCmd(
		"feishu-restart",
		"重启 Feishu/Lark 守护进程",
		async (ctx) => {
			try {
				const result = await restartDaemon();
				if (result.status === "error") {
					const stopped = result.stopped;
					ctx.ui.notify(
						tuiSafe(
							t("notify.restart_failed", {
								error:
									stopped.error instanceof Error
										? stopped.error.message
										: String(stopped.error),
								pid: stopped.owner?.pid ?? "?",
							}),
						),
						"error",
					);
					refreshStatusFromState();
					return;
				}
				notifyInfo(
					ctx,
					t("notify.restarted", {
						pid: String(result.started.owner?.pid ?? result.started.pid ?? "?"),
					}),
				);
				refreshStatusFromState();
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	);

	registerFeishuCmd(
		"feishu-reset",
		"重置所有 Feishu/Lark 配置和数据",
		async (ctx) => {
			const ok = await uiConfirm(ctx, msg("notify.reset_confirm"), false);
			if (!ok) {
				notifyInfo(ctx, msg("notify.reset_cancelled"));
				return;
			}
			await stopDaemon();
			removePath(CONFIG_PATH);
			invalidateLocale();
			removePath(STATE_PATH);
			removePath(DEDUPE_PATH);
			removePath(`${DEDUPE_PATH}.lock`);
			removePath(BRIDGE_PATH);
			conversations.resetMemory();
			messageHandler.reset();
			ensureRoot();
			updateStatus("not configured");
			notifyInfo(ctx, msg("notify.reset_done"));
			refreshStatusFromState();
		},
	);

	registerFeishuCmd(
		"feishu-status",
		"查看 Feishu/Lark 连接状态和配置",
		async (ctx) => {
			refreshStatusFromState();
			const cfg = loadConfig();
			const owner = gatewayLock?.owner || readGatewayOwner();
			notifyInfo(
				ctx,
				[
					t("notify.status_line", {
						text:
							lastStatusText ||
							(loadConfig() ? "Feishu: disconnected" : "Feishu: not configured"),
					}),
					`Gateway owner: ${formatOwner(owner)}`,
					`Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart === true}` : "missing"}`,
					`Path: ${CONFIG_PATH}`,
					`Gateway lock: ${gatewayLockPath()}`,
					`Debug: ${DEBUG_LOG_PATH}`,
					`Gateway log: ${DAEMON_LOG_PATH}`,
				].join("\n"),
			);
		},
	);

	registerFeishuCmd(
		"feishu-debug",
		"查看 Feishu/Lark 最近调试日志",
		async (ctx) => {
			if (!existsSync(DEBUG_LOG_PATH)) {
				notifyInfo(ctx, msg("notify.no_debug_log"));
				return;
			}
			const lines = readFileSync(DEBUG_LOG_PATH, "utf8")
				.trim()
				.split("\n")
				.slice(-20);
			notifyInfo(ctx, lines.join("\n"));
		},
	);

	registerFeishuCmd(
		"feishu-autostart",
		"切换 Feishu/Lark 会话启动时自动拉起守护进程",
		async (ctx) => {
			const cfg = loadConfig();
			if (!cfg) {
				ctx.ui.notify(msg("notify.missing_config_warning"), "warning");
				return;
			}
			cfg.autoStart = cfg.autoStart === false;
			writeJson(CONFIG_PATH, cfg);
			invalidateLocale();
			ctx.ui.notify(
				cfg.autoStart ? msg("notify.autostart_on") : msg("notify.autostart_off"),
				"info",
			);
			refreshStatusFromState();
		},
	);

	const bootConfig = loadConfig();

	pi.on("session_start", async (_event, ctx) => {
		uiRef = ctx.ui as any;
		startStatusRefresh();
	});

	// ── Startup model check (offline) ──
	// On pi startup (TUI only), statically validate the model references the
	// feishu bridge persists — state.json models.* and config.json
	// visionFallback.models — and warn via notify when any resolve to an
	// unknown model, an unauthenticated provider, or (vision entries) a
	// model without image input. Offline only: no live probe, so transient
	// network/auth noise never flags a model. No config/state mutation.
	// Configurable via startupModelCheck: false in feishu config.json.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const cfg = loadConfig();
		if (!cfg || cfg.startupModelCheck === false) return;

		const state = readJson<{
			models?: Record<string, { provider: string; id: string }>;
		}>(STATE_PATH, {});
		const summary = formatInvalidSummary(
			checkModels(checkRegistry(ctx.modelRegistry), {
				visionModels: cfg.visionFallback?.models,
				stateModels: state.models,
			}).invalid,
		);
		if (summary) {
			ctx.ui.notify(
				t("notify.model_check_warning", {
					summary,
				}),
				"warning",
			);
		}
	});

	if (process.env.PI_FEISHU_DAEMON === "1") {
		// Daemon always connects regardless of autoStart.
		// autoStart only controls whether the TUI auto-spawns the daemon.
		start()
			.then((result) => {
				if (typeof result === "object" && result.status === "owned") {
					console.error(
						"[feishu] daemon found existing owner, exiting:",
						formatOwner(result.owner),
					);
					process.exit(0);
				}
			})
			.catch((error) => {
				updateStatus(
					error instanceof BotUnavailableError ? "bot unavailable" : "disconnected",
				);
				console.error(
					"[feishu] daemon autoStart failed:",
					error instanceof Error ? error.message : error,
				);
				process.exit(1);
			});
	} else if (bootConfig?.autoStart === true) {
		startDaemon(false).catch((error) => {
			updateStatus("disconnected");
			debugLog("feishu.daemon.spawn_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	pi.on("session_shutdown", async () => {
		await stop();
		clearStatus();
	});
}

/**
 * Adapt a pi ModelRegistry to the minimal CheckRegistry shape used by the
 * startup model check. getAll/find/getProviderAuthStatus are all synchronous
 * on ModelRegistry; the adapter is a plain structural pass-through.
 */
function checkRegistry(registry: {
	getAll(): unknown[];
	find(provider: string, modelId: string): unknown | undefined;
	getProviderAuthStatus(
		provider: string,
	): { configured: boolean; label?: string } | undefined;
}): CheckRegistry {
	return {
		getAll: () => registry.getAll() as RegistryModelLike[],
		find: (provider, modelId) =>
			registry.find(provider, modelId) as RegistryModelLike | undefined,
		getProviderAuthStatus: (provider) => registry.getProviderAuthStatus(provider),
	};
}

function parseCopyMarkdownActionValue(
	value: unknown,
): { copySourceId: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== "pi_feishu_copy_markdown") return undefined;
	if (typeof raw.copySourceId !== "string" || !raw.copySourceId)
		return undefined;
	return { copySourceId: raw.copySourceId };
}

function parseSummarizeImagesActionValue(
	value: unknown,
): { key: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== SUMMARIZE_IMAGES_ACTION) return undefined;
	if (typeof raw.key !== "string" || !raw.key) return undefined;
	return { key: raw.key };
}
type DaemonProcessInfo = {
	pid: number;
	ppid: number;
	command: string;
};

function reapDetachedDaemonProcesses(
	options: { keepPids?: number[]; extensionPath?: string } = {},
) {
	if (process.platform === "win32") {
		reapDetachedDaemonProcessesWindows(options);
		return;
	}

	const keep = new Set(options.keepPids || []);
	const allProcesses = listProcesses();
	const roots = allProcesses.filter((proc) =>
		looksLikeFeishuDaemon(proc.command, options.extensionPath),
	);
	if (!roots.length) return;

	const byParent = new Map<number, DaemonProcessInfo[]>();
	for (const proc of allProcesses) {
		const children = byParent.get(proc.ppid) || [];
		children.push(proc);
		byParent.set(proc.ppid, children);
	}

	const toKill = new Set<number>();
	for (const proc of roots) {
		if (keep.has(proc.pid)) continue;
		toKill.add(proc.pid);
		collectDescendantPids(proc.pid, byParent, toKill, keep);
	}

	for (const pid of [...toKill].sort((a, b) => b - a)) {
		if (keep.has(pid) || pid === process.pid) continue;
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
}

function collectDescendantPids(
	pid: number,
	byParent: Map<number, DaemonProcessInfo[]>,
	toKill: Set<number>,
	keep: Set<number>,
) {
	for (const child of byParent.get(pid) || []) {
		if (keep.has(child.pid)) continue;
		toKill.add(child.pid);
		collectDescendantPids(child.pid, byParent, toKill, keep);
	}
}

function reapDetachedDaemonProcessesWindows(
	options: { keepPids?: number[]; extensionPath?: string } = {},
) {
	const keep = new Set(options.keepPids || []);
	const allProcesses = listProcesses();
	if (!allProcesses.length) return;

	// Find feishu daemon roots, kill the entire tree with taskkill /T
	const roots = allProcesses.filter((proc) =>
		looksLikeFeishuDaemon(proc.command, options.extensionPath),
	);
	for (const proc of roots) {
		if (keep.has(proc.pid)) continue;
		try {
			execSync(`taskkill /F /T /PID ${proc.pid}`, {
				timeout: 3000,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {}
	}

	// Kill orphan launcher bash processes (tail -f /dev/null + feishu, no --mode rpc)
	if (!roots.length) {
		for (const proc of allProcesses) {
			if (keep.has(proc.pid)) continue;
			if (
				proc.command.includes("tail -f /dev/null") &&
				proc.command.includes("feishu") &&
				!proc.command.includes("--mode rpc")
			) {
				try {
					execSync(`taskkill /F /T /PID ${proc.pid}`, {
						timeout: 3000,
						windowsHide: true,
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch {}
			}
		}
	}
}

function listProcesses(): DaemonProcessInfo[] {
	if (process.platform === "win32") {
		return listProcessesWindows();
	}
	const result = spawnSync("ps", ["-wwaxo", "pid=,ppid=,command="], {
		encoding: "utf8",
	});
	if (result.status !== 0 && result.status !== null) return [];
	return result.stdout
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const pidEnd = entry.indexOf(" ");
			if (pidEnd === -1) return undefined;
			const pid = Number(entry.slice(0, pidEnd));
			const rest = entry.slice(pidEnd + 1).trimStart();
			const ppidEnd = rest.indexOf(" ");
			if (ppidEnd === -1) return undefined;
			const ppid = Number(rest.slice(0, ppidEnd));
			if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return undefined;
			return { pid, ppid, command: rest.slice(ppidEnd + 1).trimStart() };
		})
		.filter((entry): entry is DaemonProcessInfo => entry !== undefined);
}

function listProcessesWindows(): DaemonProcessInfo[] {
	try {
		const result = spawnSync(
			"wmic",
			["process", "get", "ProcessId,ParentProcessId,CommandLine", "/FORMAT:LIST"],
			{ encoding: "utf8", timeout: 5000, windowsHide: true },
		);
		if (result.status !== 0 && result.status !== null) return [];
		const lines = result.stdout.split("\n");
		const processes: DaemonProcessInfo[] = [];
		let pid = 0,
			ppid = 0,
			command = "";
		for (const raw of lines) {
			const line = raw.trimEnd();
			if (line.startsWith("ProcessId=")) {
				pid = Number(line.slice("ProcessId=".length));
			} else if (line.startsWith("ParentProcessId=")) {
				ppid = Number(line.slice("ParentProcessId=".length));
			} else if (line.startsWith("CommandLine=")) {
				command = line.slice("CommandLine=".length);
			} else if (line === "") {
				if (Number.isFinite(pid) && Number.isFinite(ppid) && pid > 0) {
					processes.push({ pid, ppid, command });
				}
				pid = 0;
				ppid = 0;
				command = "";
			}
		}
		if (Number.isFinite(pid) && Number.isFinite(ppid) && pid > 0) {
			processes.push({ pid, ppid, command });
		}
		return processes;
	} catch {
		return [];
	}
}

function looksLikeFeishuDaemon(command: string, extensionPath?: string) {
	const hasDaemonFlags =
		command.includes("--mode rpc") &&
		command.includes("--no-extensions") &&
		command.includes("--no-builtin-tools");
	if (!hasDaemonFlags) return false;
	if (extensionPath) return command.includes(extensionPath);
	return command.includes("extensions/index.ts");
}

/**
 * Windows: Kill the daemon's parent bash process, which kills the entire
 * process tree (bash + tail + pi daemon) in one shot. Called BEFORE the
 * daemon PID is killed, so wmic can still find the parent relationship.
 */
function killDaemonParentWindows(daemonPid: number) {
	try {
		const result = execSync(
			`wmic process where "ProcessId=${daemonPid}" get ParentProcessId /FORMAT:LIST`,
			{
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const match = result.match(/^ParentProcessId=(\d+)/m);
		const ppid = match ? Number(match[1]) : 0;
		if (
			Number.isFinite(ppid) &&
			ppid > 1 &&
			ppid !== daemonPid &&
			ppid !== process.pid
		) {
			try {
				execSync(`taskkill /F /T /PID ${ppid}`, {
					timeout: 3000,
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch {}
			return;
		}
	} catch {
		// Parent not found; fall through to killing just the daemon
	}
	// Fallback
	try {
		execSync(`taskkill /F /PID ${daemonPid}`, {
			timeout: 3000,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {}
}
async function withDaemonSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
	return withFileLock(`${gatewayLockPath()}.spawn.lock`, fn, {
		staleMs: 30_000,
	});
}
