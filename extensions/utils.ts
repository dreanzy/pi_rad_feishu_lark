/** Shared utility functions for pi-feishu-lark */

export function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
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

/** Split text into chunks that fit within maxBytes when serialized as {"text":...} */
export function splitText(text: string, maxBytes: number) {
	const out: string[] = [];
	let rest = text.trim() || "(empty response)";
	while (textPayloadSize(rest) > maxBytes) {
		const cut = findCutIndexByBytes(rest, maxBytes);
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	out.push(rest);
	return out;
}

function findCutIndexByBytes(text: string, maxBytes: number) {
	let low = 1;
	let high = text.length;
	let best = 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const safeMid = avoidHalfSurrogate(text, mid);
		if (safeMid > 0 && textPayloadSize(text.slice(0, safeMid)) <= maxBytes) {
			best = safeMid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	const newline = text.lastIndexOf("\n", best);
	if (newline > 0 && newline >= Math.floor(best * 0.6)) return newline + 1;
	return Math.max(1, best);
}

function avoidHalfSurrogate(text: string, index: number) {
	if (index <= 0 || index >= text.length) return index;
	const prev = text.charCodeAt(index - 1);
	if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
	return index;
}

function byteSize(text: string) {
	return Buffer.byteLength(text, "utf8");
}

function textPayloadSize(text: string) {
	return byteSize(JSON.stringify({ text }));
}
