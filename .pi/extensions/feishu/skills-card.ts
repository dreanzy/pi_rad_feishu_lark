import { msg, t } from "./locale.js";
import { escapeMarkdown, sharedCardConfig } from "./cards.js";

export type SkillListItem = {
	name: string;
	description: string;
};

export type SkillListPage = {
	key: string;
	page: number;
	total: number;
	totalPages: number;
	items: SkillListItem[];
};

export type SkillParamData = {
	key: string;
	skillName: string;
};

export const SKILLS_PER_PAGE = 6;
export function buildSkillListCard(data: SkillListPage) {
	const elements: any[] = [
		{
			tag: "markdown",
			content:
				data.total > 0
					? t("card.skill.page_info", {
							page: data.page + 1,
							totalPages: data.totalPages,
							total: data.total,
						})
					: msg("card.skill.empty"),
		},
	];

	for (const item of data.items) {
		elements.push({
			tag: "div",
			text: {
				tag: "lark_md",
				content: `**${escapeMarkdown(item.name)}**\n${escapeMarkdown(item.description)}`,
			},
		});
		elements.push({
			tag: "action",
			actions: [
				{
					tag: "button",
					text: { tag: "plain_text", content: msg("card.skill.btn_direct") },
					type: "primary",
					value: {
						action: "pi_feishu_skill_direct",
						key: data.key,
						skillName: item.name,
					},
				},
				{
					tag: "button",
					text: { tag: "plain_text", content: msg("card.skill.btn_param") },
					type: "default",
					value: {
						action: "pi_feishu_skill_param",
						key: data.key,
						skillName: item.name,
						skillDesc: item.description,
					},
				},
			],
		});
	}

	elements.push({
		tag: "action",
		actions: [
			{
				tag: "button",
				text: { tag: "plain_text", content: msg("card.skill.prev_page") },
				type: "default",
				disabled: data.page <= 0,
				value: {
					action: "pi_feishu_skill_page",
					key: data.key,
					page: Math.max(0, data.page - 1),
				},
			},
			{
				tag: "button",
				text: { tag: "plain_text", content: msg("card.skill.next_page") },
				type: "default",
				disabled: data.page >= data.totalPages - 1,
				value: {
					action: "pi_feishu_skill_page",
					key: data.key,
					page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
				},
			},
		],
	});

	return {
		config: sharedCardConfig(),
		header: {
			template: "indigo",
			title: { tag: "plain_text", content: msg("card.skill.title") },
		},
		elements,
	};
}

export function buildSkillParamCard(data: SkillParamData) {
	return {
		config: sharedCardConfig(),
		header: {
			template: "indigo",
			title: {
				tag: "plain_text",
				content: t("card.skill.param_title", { name: data.skillName }),
			},
		},
		elements: [
			{
				tag: "div",
				text: {
					tag: "lark_md",
					content: t("card.skill.param_desc", { name: data.skillName }),
				},
			},
			{
				tag: "input",
				name: "skillParams",
				label: { tag: "plain_text", content: msg("card.skill.param_label") },
				placeholder: {
					tag: "plain_text",
					content: msg("card.skill.param_placeholder"),
				},
			},
			{
				tag: "action",
				actions: [
					{
						tag: "button",
						text: { tag: "plain_text", content: msg("card.skill.btn_submit") },
						type: "primary",
						value: {
							action: "pi_feishu_skill_submit",
							key: data.key,
							skillName: data.skillName,
						},
					},
					{
						tag: "button",
						text: { tag: "plain_text", content: msg("card.skill.btn_cancel") },
						type: "default",
						value: {
							action: "pi_feishu_skill_cancel",
							key: data.key,
						},
					},
				],
			},
		],
	};
}

// ── Action value parsers ──

export function parseSkillPageActionValue(
	value: unknown,
): { key: string; page: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== "pi_feishu_skill_page") return undefined;
	if (typeof raw.key !== "string") return undefined;
	if (typeof raw.page !== "number" || !Number.isFinite(raw.page))
		return undefined;
	return { key: raw.key, page: Math.max(0, Math.floor(raw.page)) };
}

export function parseSkillDirectActionValue(
	value: unknown,
): { key: string; skillName: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== "pi_feishu_skill_direct") return undefined;
	if (typeof raw.key !== "string" || typeof raw.skillName !== "string")
		return undefined;
	return { key: raw.key, skillName: raw.skillName };
}

export function parseSkillParamActionValue(
	value: unknown,
): { key: string; skillName: string; skillDesc: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== "pi_feishu_skill_param") return undefined;
	if (typeof raw.key !== "string" || typeof raw.skillName !== "string")
		return undefined;
	return {
		key: raw.key,
		skillName: raw.skillName,
		skillDesc: typeof raw.skillDesc === "string" ? raw.skillDesc : "",
	};
}

export function parseSkillSubmitActionValue(
	value: unknown,
): { key: string; skillName: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== "pi_feishu_skill_submit") return undefined;
	if (typeof raw.key !== "string" || typeof raw.skillName !== "string")
		return undefined;
	return { key: raw.key, skillName: raw.skillName };
}

export function parseSkillCancelActionValue(
	value: unknown,
): { key: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as any;
	if (raw.action !== "pi_feishu_skill_cancel") return undefined;
	if (typeof raw.key !== "string") return undefined;
	return { key: raw.key };
}
