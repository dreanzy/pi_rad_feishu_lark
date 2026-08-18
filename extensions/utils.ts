/** Shared utility functions for pi-feishu-lark */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-process lock via exclusive mkdir, with stale-lock recovery.
 * On timeout, runs fn anyway (callers rely on the gateway/dedupe lock
 * as a best-effort guard, not a hard barrier).
 */
export async function withFileLock<T>(
	lockPath: string,
	fn: () => T | Promise<T>,
	options: { staleMs: number; attempts?: number; retryMs?: number },
): Promise<T> {
	const attempts = options.attempts ?? 40;
	const retryMs = options.retryMs ?? 25;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (tryAcquireFileLock(lockPath, options.staleMs)) {
			try {
				return await fn();
			} finally {
				try {
					rmSync(lockPath, { recursive: true, force: true });
				} catch {}
			}
		}
		await sleep(retryMs);
	}
	return fn();
}

function tryAcquireFileLock(lockPath: string, staleMs: number) {
	try {
		mkdirSync(dirname(lockPath), { recursive: true });
		mkdirSync(lockPath);
		return true;
	} catch {
		try {
			const age = Date.now() - statSync(lockPath).mtimeMs;
			if (age > staleMs) rmSync(lockPath, { recursive: true, force: true });
		} catch {}
		return false;
	}
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
