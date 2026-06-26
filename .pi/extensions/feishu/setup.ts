import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import qrcode from "qrcode-terminal";
import {
	CONFIG_PATH,
	DEFAULT_CONFIG,
	ensureRoot,
	mask,
	writeJson,
} from "./config.js";
import type { Domain, FeishuConfig, GroupPolicy } from "./types.js";
import { msg, t } from "./locale.js";

export async function uiSelect<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	options: Array<{ value: T; label: string }>,
	initialValue?: T,
): Promise<T> {
	const ui: any = ctx.ui;
	if (typeof ui.select !== "function") {
		throw new Error("Current UI does not support select prompts.");
	}
	const labels = options.map((o) => o.label);
	const initialLabel = options.find((o) => o.value === initialValue)?.label;
	const selectedLabel = await ui.select(
		title,
		labels,
		initialLabel ? { initialValue: initialLabel } : undefined,
	);
	const matched = options.find((o) => o.label === selectedLabel);
	if (!matched) {
		throw new Error("Selection cancelled.");
	}
	return matched.value;
}

export async function uiInput(
	ctx: ExtensionCommandContext,
	title: string,
	defaultValue = "",
): Promise<string> {
	const ui: any = ctx.ui;
	if (typeof ui.input === "function")
		return String((await ui.input(title, defaultValue)) || "");
	if (typeof ui.prompt === "function")
		return String((await ui.prompt(title, defaultValue)) || "");
	throw new Error("Current UI does not support input prompts.");
}

export async function uiConfirm(
	ctx: ExtensionCommandContext,
	title: string,
	initial = true,
): Promise<boolean> {
	const ui: any = ctx.ui;
	if (typeof ui.confirm === "function")
		return Boolean(await ui.confirm(title, "", { initialValue: initial }));
	return initial;
}

export async function runSetup(ctx: ExtensionCommandContext) {
	ensureRoot();
	const mode = await uiSelect(
		ctx,
		msg("setup.method.title"),
		[
			{ value: "auto", label: msg("setup.method.auto") },
			{ value: "manual", label: msg("setup.method.manual") },
		],
		"auto",
	);

	let appId = "";
	let appSecret = "";
	let domain: Domain = "feishu";

	if (mode === "auto") {
		const created = await registerFeishuApp(ctx);
		appId = created.appId;
		appSecret = created.appSecret;
		domain = created.domain;
	} else {
		domain = await uiSelect(
			ctx,
			msg("setup.domain.title"),
			[
				{ value: "feishu", label: msg("setup.domain.feishu") },
				{ value: "lark", label: msg("setup.domain.lark") },
			],
			"feishu",
		);
		appId = (await uiInput(ctx, msg("setup.app_id"))).trim();
		appSecret = (await uiInput(ctx, msg("setup.app_secret"))).trim();
	}

	const groupPolicy = await uiSelect<GroupPolicy>(
		ctx,
		msg("setup.group_policy.title"),
		[
			{ value: "open", label: msg("setup.group_policy.open") },
			{ value: "mention", label: msg("setup.group_policy.mention") },
		],
		"open",
	);

	const config: FeishuConfig = {
		appId,
		appSecret,
		domain,
		groupPolicy,
		reactEmoji: DEFAULT_CONFIG.reactEmoji,
		autoStart: true,
		promptTimeoutMs: DEFAULT_CONFIG.promptTimeoutMs,
		queueTimeoutMs: DEFAULT_CONFIG.queueTimeoutMs,
	};
	writeJson(CONFIG_PATH, config);

	ctx.ui.notify(
		t("setup.saved", {
			path: CONFIG_PATH,
			id: mask(appId),
			policy: groupPolicy,
		}),
		"info",
	);

	if (await uiConfirm(ctx, msg("setup.start_confirm"), true)) {
		return config;
	}
	return undefined;
}

async function registerFeishuApp(
	ctx: ExtensionCommandContext,
): Promise<{ appId: string; appSecret: string; domain: Domain }> {
	const lark = await import("@larksuiteoapi/node-sdk");
	ctx.ui.notify(msg("setup.preparing_qr"), "info");

	const result = await lark.registerApp({
		source: "pi-feishu-extension",
		onQRCodeReady(info: { url: string; expireIn: number }) {
			qrcode.generate(info.url, { small: true }, (qr) => {
				console.log(msg("setup.qr_header"));
				console.log(qr);
				console.log(info.url);
				console.log(t("setup.qr_expire", { expireIn: info.expireIn }));
			});
			ctx.ui.notify(msg("setup.qr_scan_hint"), "info");
		},
		onStatusChange(info: any) {
			if (info?.status === "domain_switched") {
				ctx.ui.notify(msg("setup.lark_detected"), "info");
			}
		},
	});

	const domain: Domain =
		result?.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
	return {
		appId: result.client_id,
		appSecret: result.client_secret,
		domain,
	};
}
