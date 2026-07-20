type LocaleKey = "zh_cn" | "en_us";
import { getLocale, msg } from "./locale.js";

type PostTextElement = {
	tag: "text";
	text: string;
	style?: string[];
};

type PostLinkElement = {
	tag: "a";
	text: string;
	href: string;
};

type PostElement = PostTextElement | PostLinkElement;

export type FeishuMessageMode = "text" | "post" | "interactive";
export type MarkdownCardPart = {
	card: object;
	markdown: string;
};

const POST_LENGTH_THRESHOLD = 250;
const INTERACTIVE_LENGTH_THRESHOLD = 1200;
const MAX_POST_CHARS = 3500;
const MAX_CARD_BYTES = 29 * 1024;

export function shouldUseRichText(text: string) {
	return chooseMessageMode(text) === "post";
}

export function chooseMessageMode(text: string): FeishuMessageMode {
	const trimmed = text.trim();
	if (!trimmed) return "text";
	const metrics = analyzeText(trimmed);
	if (
		trimmed.length >= INTERACTIVE_LENGTH_THRESHOLD ||
		metrics.hasTable ||
		metrics.codeBlockCount > 0 ||
		metrics.headingCount >= 3 ||
		metrics.listItemCount >= 8 ||
		metrics.linkCount >= 5
	) {
		return "interactive";
	}
	if (
		metrics.lineCount >= 2 &&
		(metrics.looksLikeMarkdown || trimmed.length >= POST_LENGTH_THRESHOLD)
	)
		return "post";
	return "text";
}

export function buildMarkdownCard(
	text: string,
	language: "zh" | "en" = getLocale(),
) {
	const trimmed = text.trim() || "(empty response)";
	const { title, body } = extractMarkdownTitle(trimmed);
	return createMarkdownCard(title, body || trimmed);
}

export function buildMarkdownCards(
	text: string,
	language: "zh" | "en" = getLocale(),
) {
	return buildMarkdownCardParts(text, language).map((part) => part.card);
}

export function buildMarkdownCardParts(
	text: string,
	language: "zh" | "en" = getLocale(),
	copySourceId?: (index: number) => string,
): MarkdownCardPart[] {
	const trimmed = text.trim() || "(empty response)";
	const { title, body } = extractMarkdownTitle(trimmed);
	const withCopyButton = Boolean(copySourceId);
	const fullCard = createMarkdownCard(
		title,
		body || trimmed,
		withCopyButton ? "__copy_source_id__" : undefined,
	);
	if (byteSize(fullCard) < MAX_CARD_BYTES) {
		const markdown = body || trimmed;
		return [
			{
				card: createMarkdownCard(title, markdown, copySourceId?.(0)),
				markdown,
			},
		];
	}

	const parts = splitMarkdownToFit(body || trimmed, title, withCopyButton);
	if (parts.length === 1)
		return [
			{
				card: createMarkdownCard(title, parts[0], copySourceId?.(0)),
				markdown: parts[0],
			},
		];
	return parts.map((part, index) => ({
		card: createMarkdownCard(
			`${title} (${index + 1}/${parts.length})`,
			part,
			copySourceId?.(index),
		),
		markdown: part,
	}));
}

function createMarkdownCard(
	title: string,
	content: string,
	copySourceId?: string,
) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: title,
			},
			template: "blue",
		},
		body: {
			elements: [
				{
					tag: "markdown",
					content,
				},
				...(copySourceId
					? [
							{
								tag: "button",
								text: {
									tag: "plain_text",
									content: msg("rich_text.copy_button"),
								},
								type: "default",
								width: "default",
								behaviors: [
									{
										type: "callback",
										value: {
											action: "pi_feishu_copy_markdown",
											copySourceId,
										},
									},
								],
							},
						]
					: []),
			],
		},
	};
}

function analyzeText(text: string) {
	const lines = text.split(/\r?\n/);
	const lineCount = lines.filter((line) => line.trim()).length;
	const tableLineCount = lines.filter((line) =>
		/^\s*\|.+\|\s*$/.test(line),
	).length;
	const hasTableSeparator = lines.some((line) =>
		/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line),
	);
	return {
		lineCount,
		looksLikeMarkdown: looksLikeMarkdown(text),
		hasTable: tableLineCount >= 2 && hasTableSeparator,
		codeBlockCount:
			(text.match(/```/g) || []).length >= 2
				? Math.floor((text.match(/```/g) || []).length / 2)
				: 0,
		headingCount: lines.filter((line) => /^#{1,6}\s+\S/.test(line.trim()))
			.length,
		listItemCount: lines.filter((line) => /^\s*([-*+]|\d+\.)\s+\S/.test(line))
			.length,
		linkCount: (text.match(/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g) || []).length,
	};
}

export function buildPostMessages(
	text: string,
	language: "zh" | "en" = getLocale(),
) {
	return splitPostText(text.trim() || "(empty response)", MAX_POST_CHARS).map(
		(chunk, index, chunks) => {
			const parsed = markdownToPost(chunk);
			const title =
				chunks.length > 1
					? `${parsed.title} (${index + 1}/${chunks.length})`
					: parsed.title;
			const locale = getLocale() === "zh" ? "zh_cn" : "en_us";
			const post = {
				title,
				content: parsed.content.length
					? parsed.content
					: [[{ tag: "text", text: chunk }]],
			};
			return {
				[locale]: post,
				[fallbackLocale(locale)]: post,
			};
		},
	);
}

function looksLikeMarkdown(text: string) {
	return [
		/^#{1,6}\s+\S/m,
		/^\s*[-*+]\s+\S/m,
		/^\s*\d+\.\s+\S/m,
		/^>\s+\S/m,
		/```[\s\S]*?```/,
		/\*\*[^*\n][\s\S]*?\*\*/,
		/`[^`\n]+`/,
		/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/,
		/^\s*\|.+\|\s*$/m,
	].some((pattern) => pattern.test(text));
}

function markdownToPost(text: string) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const titleIndex = lines.findIndex((line) => line.trim());
	const firstLine = titleIndex >= 0 ? lines[titleIndex].trim() : "";
	const heading = firstLine.match(/^#{1,6}\s+(.+)$/);
	const title = cleanInlineMarkdown(
		heading?.[1] || firstLine || msg("rich_text.title_fallback"),
	).slice(0, 120);
	const content: PostElement[][] = [];
	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (i === titleIndex) continue;
		if (/^```/.test(trimmed)) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (inCodeBlock) {
			content.push([{ tag: "text", text: raw }]);
			continue;
		}

		const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (headingMatch) {
			content.push([
				{
					tag: "text",
					text: cleanInlineMarkdown(headingMatch[1]),
					style: ["bold"],
				},
			]);
			continue;
		}

		const quoteMatch = trimmed.match(/^>\s+(.+)$/);
		if (quoteMatch) {
			content.push([
				{ tag: "text", text: `> ${cleanInlineMarkdown(quoteMatch[1])}` },
			]);
			continue;
		}

		const listMatch = trimmed.match(/^([-*+]|\d+\.)\s+(.+)$/);
		if (listMatch) {
			content.push([
				{
					tag: "text",
					text: `${listMatch[1].match(/\d+\./) ? listMatch[1] : "•"} ${cleanInlineMarkdown(listMatch[2])}`,
				},
			]);
			continue;
		}

		if (/^\s*\|.+\|\s*$/.test(raw)) {
			content.push([{ tag: "text", text: formatTableLine(raw) }]);
			continue;
		}

		content.push(parseInlineElements(trimmed));
	}

	return { title, content };
}

function extractMarkdownTitle(text: string) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const titleIndex = lines.findIndex((line) => line.trim());
	if (titleIndex < 0)
		return { title: msg("rich_text.title_fallback"), body: text };
	const firstLine = lines[titleIndex].trim();
	const heading = firstLine.match(/^#{1,6}\s+(.+)$/);
	const title = cleanInlineMarkdown(
		heading?.[1] || firstLine || msg("rich_text.title_fallback"),
	).slice(0, 120);
	const body = lines
		.filter((_, index) => index !== titleIndex)
		.join("\n")
		.trim();
	return { title, body };
}

function splitMarkdownToFit(
	markdown: string,
	title: string,
	withCopyButton = false,
) {
	// If the whole thing fits, send it as one card.
	if (fitsMarkdownCard(title, markdown, withCopyButton)) return [markdown];

	// Split on <hr> first — natural section boundary.
	const hrParts = markdown
		.split(/\n\s*---\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (hrParts.length > 1) {
		const allFit = hrParts.every((p) =>
			fitsMarkdownCard(title, p, withCopyButton),
		);
		if (allFit) return hrParts;
	}

	// ponytail: single paragraph >29KB not split; add line-level split if card payload errors surface.
	// Split on double-newline (paragraph). Greedily pack paragraphs into cards.
	const parts: string[] = [];
	let current = "";
	for (const para of markdown.split(/\n{2,}/)) {
		const trimmed = para.trim();
		if (!trimmed) continue;
		const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
		if (fitsMarkdownCard(title, candidate, withCopyButton)) {
			current = candidate;
		} else {
			if (current) parts.push(current);
			current = trimmed;
		}
	}
	if (current) parts.push(current);
	return parts.length ? parts : [markdown];
}

function fitsMarkdownCard(
	title: string,
	content: string,
	withCopyButton = false,
) {
	return (
		byteSize(
			createMarkdownCard(
				title,
				content,
				withCopyButton ? "__copy_source_id__" : undefined,
			),
		) < MAX_CARD_BYTES
	);
}

function byteSize(value: unknown) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseInlineElements(text: string): PostElement[] {
	const out: PostElement[] = [];
	const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
	let lastIndex = 0;
	for (const match of text.matchAll(linkPattern)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			out.push({
				tag: "text",
				text: cleanInlineMarkdown(text.slice(lastIndex, index)),
			});
		}
		out.push({ tag: "a", text: cleanInlineMarkdown(match[1]), href: match[2] });
		lastIndex = index + match[0].length;
	}
	if (lastIndex < text.length) {
		out.push({ tag: "text", text: cleanInlineMarkdown(text.slice(lastIndex)) });
	}
	return out.length ? out : [{ tag: "text", text }];
}

function cleanInlineMarkdown(text: string) {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.trim();
}

function formatTableLine(line: string) {
	const cells = line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
	if (cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
		return "----------------";
	return cells.join("  |  ");
}

function splitPostText(text: string, max: number) {
	const out: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max * 0.5) cut = max;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).trimStart();
	}
	out.push(rest);
	return out;
}

function fallbackLocale(locale: LocaleKey): LocaleKey {
	return locale === "zh_cn" ? "en_us" : "zh_cn";
}
