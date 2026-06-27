import { loadConfig } from "./config.js";

export type Locale = "zh" | "en";

const _cache: { locale?: Locale } = {};

/** Detect the effective locale — config override → terminal env (LANG) → "en" default */
export function getLocale(): Locale {
	if (_cache.locale) return _cache.locale;

	// Config override takes precedence
	const cfg = loadConfig();
	if (cfg?.language === "zh" || cfg?.language === "en") {
		_cache.locale = cfg.language;
		return _cache.locale;
	}

	// Detect from terminal locale
	// Unix: LANG, LC_ALL, LC_MESSAGES
	// Windows (Git Bash/MSYS2): LANG is typically set
	const lang =
		process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "";
	_cache.locale = lang.startsWith("zh") ? "zh" : "en";
	return _cache.locale;
}

/** Invalidate cached locale (call after config changes or language switch) */
export function invalidateLocale() {
	delete _cache.locale;
}

/** Check if current locale is Chinese */
export function isZh(): boolean {
	return getLocale() === "zh";
}

/** Get a translated string for the current locale (simple key lookup) */
export function msg(key: string): string {
	const locale = getLocale();
	return (
		(TRANSLATIONS[locale] as Record<string, string>)[key] ||
		(TRANSLATIONS.en as Record<string, string>)[key] ||
		key
	);
}

/**
 * Get a translated string with interpolation.
 * Placeholders use `${name}` syntax.
 * @example t("当前模型：**${current}**", { current: "openai/gpt-4" })
 */
export function t(
	template: string,
	vars?: Record<string, string | number>,
): string {
	const locale = getLocale();
	let text = (TRANSLATIONS[locale] as Record<string, string>)[template];
	if (text === undefined)
		text = (TRANSLATIONS.en as Record<string, string>)[template];
	if (text === undefined) text = template;
	if (!vars) return text;
	return text.replace(/\$\{(\w+)\}/g, (_, key) =>
		String(vars[key] ?? `\${${key}}`),
	);
}

/** Join error messages with locale-appropriate separator */
export function joinErrors(errors: string[]): string {
	return errors.join(getLocale() === "zh" ? "；" : "; ");
}

// ============================================================
// All translations — flat key → { zh, en } entries
// ============================================================

const TRANSLATIONS: Record<Locale, Record<string, string>> = {
	zh: {
		// ============= cards.ts =============
		"model.not_selected": "未选择",
		"card.select_model.title": "选择 Pi 模型",
		"card.current_model.desc":
			"当前模型：**${current}**\n点击下面的按钮即可切换当前飞书会话使用的模型。",
		"card.current_prefix": "当前 ",
		"card.resume.scope.current": "当前项目",
		"card.resume.scope.all": "全部会话",
		"card.resume.view": "当前视图：**${scope}**",
		"card.resume.page_info":
			"第 **${page} / ${totalPages}** 页，共 **${total}** 条历史会话。",
		"card.resume.empty": "还没有可切换的历史会话。",
		"card.resume.hint":
			"点击某条会话后，当前飞书对话会继续接着这条 Pi 会话往下聊。",
		"card.resume.current_badge": " `当前使用中`",
		"card.resume.modified_label": "更新时间：",
		"card.resume.workspace_label": "工作区：",
		"card.resume.current_session": "当前会话",
		"card.resume.switch_to": "切换到这条会话",
		"card.resume.prev_page": "上一页",
		"card.resume.next_page": "下一页",
		"card.resume.title": "切换 Pi 历史会话",
		"card.workspace_list.title": "切换工作区",
		"card.workspace_list.workspace_label": "工作区：",
		"card.workspace_list.current_badge": " `当前`",
		"card.workspace_list.switch_to": "切换到该工作区",
		"card.workspace_list.empty":
			"没有可用工作区。请先使用 /workspace 路径 切换到某个工作区。",
		"card.workspace_list.hint": "点击按钮即可切换到对应工作区。",

		// ============= skills-card.ts =============
		"card.skill.title": "Pi 技能列表",
		"card.skill.page_info":
			"第 **${page} / ${totalPages}** 页，共 **${total}** 个技能。",
		"card.skill.empty": "没有可用技能。",
		"card.skill.btn_direct": "直接使用",
		"card.skill.btn_param": "传参使用",
		"card.skill.prev_page": "上一页",
		"card.skill.next_page": "下一页",
		"card.skill.param_title": "🎯 使用技能: ${name}",
		"card.skill.param_desc": "请输入要传给技能「${name}」的内容或参数：",
		"card.skill.param_label": "参数内容",
		"card.skill.param_placeholder": "输入参数...",
		"card.skill.btn_submit": "提交并执行",
		"card.skill.btn_cancel": "取消",
		"card.skill.sending": "正在使用技能「${name}」...",

		// ============= conversation-manager.ts =============
		"conversation.timeout":
			"Pi 模型处理超时，请稍后重试；如果是图片消息，可以先切换到明确支持图片的模型。",
		"conversation.not_running": "当前没有进行中的处理。",
		"conversation.stale_card": "这张任务卡片已不是当前进行中的任务。",
		"conversation.user_stopped": "用户已停止任务",
		"conversation.stopped": "已停止当前处理。",
		"conversation.stop_failed": "停止失败，请重试。",
		"conversation.new_created":
			"已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。",
		"conversation.message_count": "消息数：${count}",
		"conversation.busy_resume":
			"当前还有进行中的处理，请先发送 /stop，再切换历史会话。",
		"conversation.not_found":
			"这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。",
		"conversation.already_in": "你已经在这个历史会话里了。",
		"conversation.current_workspace": "当前工作区：${path}",
		"conversation.switched_session": "已切换到历史会话：${name}",
		"conversation.workspace_label": "工作区：${path}",
		"conversation.next_message": "下一条消息会继续接着这个会话往下聊。",
		"conversation.model_unavailable":
			"这个模型当前不可用：${model}。请发送 /model 重新选择。",
		"conversation.model_switched":
			"已切换到 ${model}。当前飞书会话后续都会使用这个模型。",
		"conversation.workspace_current": "当前工作区：${path}",
		"conversation.workspace_usage": "用法：/workspace /绝对路径",
		"conversation.workspace_tilde": "也支持：/workspace ~/your/project",
		"conversation.workspace_switched": "已切换到工作区：${path}",
		"conversation.workspace_next": "下一条消息会在这个目录里创建新的 Pi 会话。",
		"conversation.queue_timeout": "上一条飞书消息处理超时，已跳过等待。",
		"conversation.not_found_deleted": "历史会话不存在，可能已经被删除。",
		"conversation.workspace_usage_detail":
			"请在 /workspace 后面带上目录路径，例如：/workspace /Users/ax/project",
		"conversation.workspace_absolute_only":
			"当前只支持绝对路径或 ~/ 开头的路径。",
		"conversation.workspace_not_exist": "工作区不存在：${path}",
		"conversation.workspace_not_accessible": "无法访问工作区：${path}",
		"conversation.workspace_not_dir": "工作区不是目录：${path}",
		"conversation.unnamed_session": "未命名会话",
		"conversation.unknown_date": "未知",

		// ============= task-status-card.ts =============
		"task.phase.starting": "开始处理",
		"task.phase.still_running": "仍在处理",
		"task.phase.current": "当前阶段：${phase}",
		"task.button.stop": "停止任务",
		"task.status.done": "任务完成",
		"task.status.failed": "任务失败",
		"task.status.stopped": "任务已停止",
		"task.status.inactive": "任务已结束",
		"task.status.running": "任务进行中",
		"task.final_phase.failed": "处理失败",
		"task.final_phase.stopped": "用户已停止任务",

		// ============= message-handler.ts =============
		"handler.image.unsupported_model":
			"当前模型不支持图片解析。请先发送 /model 并切换到支持图片的模型后，再重发图片。",
		"handler.no_content": "没有可处理的内容：${errors}",
		"handler.model.none":
			"当前没有可用模型。请先在 Pi 里完成模型登录或 API Key 配置。",
		"handler.image.download_unavailable": "飞书连接不可用，图片无法下载",
		"handler.image.download_timeout": "图片下载超时",
		"handler.image.unsupported_format":
			"图片格式暂不支持（仅支持 png/jpg/webp）",
		"handler.image.download_failed": "图片下载失败",
		"handler.file.unsupported_type": "文件类型不支持：${name}",
		"handler.file.download_unavailable":
			"飞书连接不可用，文件无法下载：${name}",
		"handler.file.download_timeout": "文件下载超时：${name}",
		"handler.file.unreadable": "文件无法按文本读取：${name}",
		"handler.file.download_failed": "文件下载失败：${name}",
		"handler.file.truncated": "\n[内容过长，已截断]",
		"handler.file.section":
			"[Feishu file: ${name}]\n```${language}\n${text}\n```",
		"handler.prompt.analyze_image": "请根据图片内容进行分析。",
		"handler.prompt.image_hint":
			"[提示：当前模型不支持图片，本次仅处理文本/文件内容。]",
		"handler.prompt.attachment_errors": "[部分附件未处理：${errors}]",

		// ============= messages.ts =============
		"msg.label.p2p": "[飞书私聊]",
		"msg.label.thread": "[飞书话题]",
		"msg.label.group": "[飞书群聊]",

		// ============= index.ts =============
		"status.not_configured": "未配置",
		"status.connecting": "连接中",
		"status.connected": "已连接",
		"status.disconnected": "已断开",
		"status.owned": "连接被占用",
		"status.bot_unavailable": "机器人不可用",
		"status.missing_config": "配置不存在，请先运行 /feishu setup。",
		"card.copy.stale": "MD 原文已过期，请重新生成卡片。",
		"notify.daemon_already_running": "飞书连接已在后台运行。\n${owner}",
		"notify.daemon_started": "飞书连接已启动。\n网关 pid=${pid}\n日志：${path}",
		"notify.stop_failed": "停止飞书连接失败：${error}\n所有者：${owner}",
		"notify.not_running": "飞书连接未在运行。",
		"notify.stopped": "飞书连接已停止。",
		"notify.restart_failed": "飞书连接重启失败：${error}\n所有者：${owner}",
		"notify.restarted":
			"飞书连接已重启，最新代码和配置已生效。\n所有者：${owner}\n日志：${path}",
		"notify.reset_confirm":
			"确认重置飞书扩展？会删除配置和会话映射，但保留所有会话历史。",
		"notify.reset_cancelled": "已取消重置",
		"notify.reset_done":
			"飞书扩展已重置，会话历史已保留，请运行 /feishu setup。",
		"notify.status_line": "状态：${text}",
		"notify.no_debug_log":
			"还没有飞书调试日志。请先在飞书里发一条消息给机器人。",
		"notify.missing_config_warning": "配置不存在，请先运行 /feishu setup。",
		"notify.autostart_on": "飞书自动启动已开启。",
		"notify.autostart_off": "飞书自动启动已关闭。",
		"notify.commands_hint":
			"可用命令：/feishu setup | start | stop | restart | status | debug | autostart | reset",

		// ============= rich-text.ts =============
		"rich_text.copy_button": "返回MD原文",
		"rich_text.title_fallback": "Pi 回复",

		// ============= setup.ts =============
		"setup.method.title": "配置方式",
		"setup.method.auto": "扫码自动创建飞书助手",
		"setup.method.manual": "手动填写已有应用",
		"setup.domain.title": "应用区域",
		"setup.domain.feishu": "Feishu 中国",
		"setup.domain.lark": "Lark 国际",
		"setup.app_id": "应用 ID",
		"setup.app_secret": "应用密钥",
		"setup.group_policy.title": "群聊策略",
		"setup.group_policy.open": "不需要 @，群/话题消息自动回复",
		"setup.group_policy.mention": "只有 @ 机器人才回复",
		"setup.saved":
			"飞书配置已保存\n路径：${path}\nApp ID：${id}\n群聊策略：${policy}",
		"setup.start_confirm": "现在启动飞书连接？",
		// ============= bridge-runtime.ts =============
		"bridge.subagent_error": "定时任务执行失败：${error}",
		"setup.preparing_qr": "正在准备飞书授权二维码...",
		"setup.qr_scan_hint": "请在终端扫描二维码，或打开终端中显示的链接。",
		"setup.qr_header": "\n飞书/Lark 授权二维码",
		"setup.qr_expire": "二维码 ${expireIn} 秒后过期",
		"setup.lark_detected": "检测到 Lark 租户，正在切换区域。",
	},

	en: {
		// ============= cards.ts =============
		"model.not_selected": "Not selected",
		"card.select_model.title": "Select Pi Model",
		"card.current_model.desc":
			"Current model: **${current}**\nClick a button below to switch the model used by this Feishu conversation.",
		"card.current_prefix": "",
		"card.resume.scope.current": "Current project",
		"card.resume.scope.all": "All sessions",
		"card.resume.view": "Current view: **${scope}**",
		"card.resume.page_info":
			"Page **${page} / ${totalPages}**, **${total}** sessions total.",
		"card.resume.empty": "No historical sessions available.",
		"card.resume.hint":
			"Click a session to continue that Pi conversation in this Feishu chat.",
		"card.resume.current_badge": " `current`",
		"card.resume.modified_label": "Updated: ",
		"card.resume.workspace_label": "Workspace: ",
		"card.resume.current_session": "Current session",
		"card.resume.switch_to": "Switch to this session",
		"card.resume.prev_page": "Previous",
		"card.resume.next_page": "Next",
		"card.resume.title": "Switch Pi Session",
		"card.workspace_list.title": "Switch Workspace",
		"card.workspace_list.workspace_label": "Workspace: ",
		"card.workspace_list.current_badge": " `current`",
		"card.workspace_list.switch_to": "Switch to this workspace",
		"card.workspace_list.empty":
			"No workspaces available. Use /workspace path to switch to one first.",
		"card.workspace_list.hint": "Click a button to switch to that workspace.",

		// ============= skills-card.ts =============
		"card.skill.title": "Pi Skills",
		"card.skill.page_info":
			"Page **${page} / ${totalPages}**, **${total}** skills total.",
		"card.skill.empty": "No skills available.",
		"card.skill.btn_direct": "Direct Use",
		"card.skill.btn_param": "With Params",
		"card.skill.prev_page": "Previous",
		"card.skill.next_page": "Next",
		"card.skill.param_title": "🎯 Use Skill: ${name}",
		"card.skill.param_desc":
			"Enter content or parameters for skill「${name}」:",
		"card.skill.param_label": "Parameters",
		"card.skill.param_placeholder": "Enter parameters...",
		"card.skill.btn_submit": "Submit & Run",
		"card.skill.btn_cancel": "Cancel",
		"card.skill.sending": "Using skill「${name}」...",

		// ============= conversation-manager.ts =============
		"conversation.timeout":
			"Pi model processing timed out. Please retry later; if you sent an image, try switching to a model that supports images first.",
		"conversation.not_running": "No processing is currently in progress.",
		"conversation.stale_card":
			"This task card is no longer the currently active task.",
		"conversation.user_stopped": "User stopped the task",
		"conversation.stopped": "Stopped the current processing.",
		"conversation.stop_failed": "Stop failed. Please try again.",
		"conversation.new_created":
			"Created a new session. The previous session history has been preserved. The next message will start with a fresh context.",
		"conversation.message_count": "Messages: ${count}",
		"conversation.busy_resume":
			"Processing is still in progress. Please send /stop first, then switch sessions.",
		"conversation.not_found":
			"That historical session does not exist — it may have been deleted. Please open /resume again to select.",
		"conversation.already_in": "You are already in this historical session.",
		"conversation.current_workspace": "Current workspace: ${path}",
		"conversation.switched_session": "Switched to historical session: ${name}",
		"conversation.workspace_label": "Workspace: ${path}",
		"conversation.next_message": "The next message will continue this session.",
		"conversation.model_unavailable":
			"Model is currently unavailable: ${model}. Send /model to select another one.",
		"conversation.model_switched":
			"Switched to ${model}. This Feishu conversation will use this model going forward.",
		"conversation.workspace_current": "Current workspace: ${path}",
		"conversation.workspace_usage": "Usage: /workspace /absolute/path",
		"conversation.workspace_tilde": "Also supported: /workspace ~/your/project",
		"conversation.workspace_switched": "Switched to workspace: ${path}",
		"conversation.workspace_next":
			"The next message will create a new Pi session in this directory.",
		"conversation.queue_timeout":
			"Previous Feishu message processing timed out, skipped waiting.",
		"conversation.not_found_deleted":
			"Historical session does not exist — it may have been deleted.",
		"conversation.workspace_usage_detail": "Usage: /workspace <absolute-path>",
		"conversation.workspace_absolute_only":
			"Only absolute paths or ~/ relative paths are supported.",
		"conversation.workspace_not_exist": "Workspace does not exist: ${path}",
		"conversation.workspace_not_accessible": "Cannot access workspace: ${path}",
		"conversation.workspace_not_dir": "Workspace is not a directory: ${path}",
		"conversation.unnamed_session": "Unnamed session",
		"conversation.unknown_date": "Unknown",

		// ============= task-status-card.ts =============
		"task.phase.starting": "Starting",
		"task.phase.still_running": "Still processing",
		"task.phase.current": "Current phase: ${phase}",
		"task.button.stop": "Stop",
		"task.status.done": "Task complete",
		"task.status.failed": "Task failed",
		"task.status.stopped": "Task stopped",
		"task.status.inactive": "Task ended",
		"task.status.running": "Task in progress",
		"task.final_phase.failed": "Processing failed",
		"task.final_phase.stopped": "User stopped the task",

		// ============= message-handler.ts =============
		"handler.image.unsupported_model":
			"The current model does not support image analysis. Send /model to switch to a model that supports images, then resend the image.",
		"handler.no_content": "No processable content: ${errors}",
		"handler.model.none":
			"No models available. Please log in or configure API keys in Pi first.",
		"handler.image.download_unavailable":
			"Feishu connection unavailable, cannot download image",
		"handler.image.download_timeout": "Image download timed out",
		"handler.image.unsupported_format":
			"Image format not supported (only png/jpg/webp)",
		"handler.image.download_failed": "Image download failed",
		"handler.file.unsupported_type": "File type not supported: ${name}",
		"handler.file.download_unavailable":
			"Feishu connection unavailable, cannot download file: ${name}",
		"handler.file.download_timeout": "File download timed out: ${name}",
		"handler.file.unreadable": "Could not read file as text: ${name}",
		"handler.file.download_failed": "File download failed: ${name}",
		"handler.file.truncated": "\n[Content too long, truncated]",
		"handler.file.section":
			"[Feishu file: ${name}]\n```${language}\n${text}\n```",
		"handler.prompt.analyze_image":
			"Please analyze the image content provided.",
		"handler.prompt.image_hint":
			"[Note: current model does not support images; processing text/file content only.]",
		"handler.prompt.attachment_errors":
			"[Some attachments were not processed: ${errors}]",

		// ============= messages.ts =============
		"msg.label.p2p": "[Feishu DM]",
		"msg.label.thread": "[Feishu thread]",
		"msg.label.group": "[Feishu group]",

		// ============= index.ts =============
		"status.not_configured": "Not configured",
		"status.connecting": "Connecting",
		"status.connected": "Connected",
		"status.disconnected": "Disconnected",
		"status.owned": "In use by another process",
		"status.bot_unavailable": "Bot unavailable",
		"status.missing_config": "Missing config. Run /feishu setup first.",
		"card.copy.stale": "MD source is outdated. Please regenerate the card.",
		"notify.daemon_already_running":
			"Feishu connection is already running in the background.\n${owner}",
		"notify.daemon_started":
			"Feishu connection started.\nGateway pid=${pid}\nLog: ${path}",
		"notify.stop_failed":
			"Failed to stop Feishu connection: ${error}\nOwner: ${owner}",
		"notify.not_running": "Feishu connection is not running.",
		"notify.stopped": "Feishu connection has stopped.",
		"notify.restart_failed":
			"Failed to restart Feishu connection: ${error}\nOwner: ${owner}",
		"notify.restarted":
			"Feishu connection restarted. Latest code and config are active.\nOwner: ${owner}\nLog: ${path}",
		"notify.reset_confirm":
			"Reset Feishu extension? This will delete config and conversation mappings, but keep all session history.",
		"notify.reset_cancelled": "Reset cancelled.",
		"notify.reset_done":
			"Feishu extension reset. Session history was kept. Run /feishu setup.",
		"notify.status_line": "Status: ${text}",
		"notify.no_debug_log":
			"No Feishu debug log yet. Send a message to the bot first.",
		"notify.missing_config_warning": "Missing config. Run /feishu setup first.",
		"notify.autostart_on": "Feishu auto-start has been enabled.",
		"notify.autostart_off": "Feishu auto-start has been disabled.",
		"notify.commands_hint":
			"Available commands: /feishu setup | start | stop | restart | status | debug | autostart | reset",

		// ============= rich-text.ts =============
		"rich_text.copy_button": "View MD source",
		"rich_text.title_fallback": "Pi reply",

		// ============= setup.ts =============
		"setup.method.title": "Setup method",
		"setup.method.auto": "Create by QR code",
		"setup.method.manual": "Configure existing app",
		"setup.domain.title": "App region",
		"setup.domain.feishu": "Feishu China",
		"setup.domain.lark": "Lark Global",
		"setup.app_id": "App ID",
		"setup.app_secret": "App Secret",
		"setup.group_policy.title": "Group policy",
		"setup.group_policy.open": "Open — auto reply in groups/topics without @",
		"setup.group_policy.mention":
			"Mention — reply only when the bot is @mentioned",
		"setup.saved":
			"Feishu config saved\nPath: ${path}\nApp ID: ${id}\nGroup policy: ${policy}",
		"setup.start_confirm": "Start Feishu now?",
		// ============= bridge-runtime.ts =============
		"bridge.subagent_error": "Subagent task failed: ${error}",
		"setup.preparing_qr": "Preparing Feishu authorization QR code...",
		"setup.qr_scan_hint":
			"Scan the QR code in terminal, or open the link printed there.",
		"setup.qr_header": "\nFeishu/Lark authorization QR code",
		"setup.qr_expire": "QR code expires in ${expireIn} seconds.",
		"setup.lark_detected": "Detected Lark tenant; switching domain.",
	},
};
