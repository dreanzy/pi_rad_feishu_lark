/**
 * Startup model reference validation for the feishu bridge config.
 *
 * Statically checks every model reference persisted by the extension:
 *   - state.json  models.*            → { provider, id } per Feishu conversation
 *   - config.json visionFallback.models → "provider/model[:level]" strings
 *
 * A reference is reported invalid when the registry cannot resolve it to a
 * known model, or its provider has no configured auth, or (for vision
 * fallback entries only) the model lacks image input capability. Offline
 * only — no live probe — so a reference is never flagged on transient
 * network/auth noise.
 *
 * References are normalized before matching: a leading provider segment that
 * repeats inside the model id (pi's "command-code" style nested ids) is
 * tolerated by trying the exact {provider,id} pair first and falling back to
 * a bare model-id lookup.
 */

/** Minimal shape of a registry model that validation needs. */
export interface RegistryModelLike {
	id: string;
	provider: string;
	/** Input modalities (pi Model.input is non-optional). */
	input: string[];
}

/** Registry subset required by the checks (keeps callers mockable). */
export type CheckRegistry = {
	getAll(): RegistryModelLike[];
	find(provider: string, id: string): RegistryModelLike | undefined;
	getProviderAuthStatus(
		provider: string,
	): { configured: boolean; label?: string } | undefined;
};

/** One model reference found in feishu config/state files. */
export interface ModelRefEntry {
	/** "state" or "config" — which file the reference came from. */
	source: "state" | "config";
	/** Conversation key (state) or "visionFallback" (config). */
	scope: string;
	ref: string;
}

export interface CheckResult {
	valid: ModelRefEntry[];
	invalid: Array<ModelRefEntry & { reason: string }>;
}

/** Strip a trailing ":level" when it is a known thinking level (mirrors pi). */
export const VALID_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function stripThinkingLevel(ref: string): {
	modelRef: string;
	level: string | undefined;
} {
	const idx = ref.lastIndexOf(":");
	if (idx === -1) return { modelRef: ref, level: undefined };
	const suffix = ref.slice(idx + 1);
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(suffix)) {
		return { modelRef: ref.slice(0, idx), level: suffix };
	}
	return { modelRef: ref, level: undefined };
}

/** Split a model ref into provider + model-id (first "/" separates). */
export function splitProviderRef(ref: string): {
	provider: string;
	id: string;
} {
	const slash = ref.indexOf("/");
	if (slash === -1) return { provider: "", id: ref };
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/**
 * Resolve a model ref against the registry.
 * 1. Exact {provider, id} when a provider segment is present.
 * 2. Fallback: whole ref as a bare model id (registry ids may nest
 *    slashes — e.g. "deepseek/deepseek-v4-flash" with a leading
 *    provider segment stripped, or a bare ref that itself contains one).
 */
export function findModelByRef(
	registry: CheckRegistry,
	ref: string,
): RegistryModelLike | undefined {
	const { modelRef } = stripThinkingLevel(ref);
	const { provider, id } = splitProviderRef(modelRef);
	if (provider) {
		const exact = registry.find(provider, id);
		if (exact) return exact;
	}
	return registry.getAll().find((m) => m.id === modelRef);
}

/** A single model reference from config.json visionFallback.models (array). */
export function collectVisionRefs(
	models: readonly string[] | undefined,
): Array<{ ref: string; index: number }> {
	if (!Array.isArray(models)) return [];
	const refs: Array<{ ref: string; index: number }> = [];
	for (let i = 0; i < models.length; i++) {
		const entry = models[i];
		if (typeof entry === "string" && entry.trim())
			refs.push({ ref: entry.trim(), index: i });
	}
	return refs;
}

/** A single model reference from state.json models.{key}. */
export function collectStateRefs(
	models: Record<string, { provider: string; id: string }> | undefined,
): Array<{ scope: string; ref: string }> {
	if (!models || typeof models !== "object") return [];
	const refs: Array<{ scope: string; ref: string }> = [];
	for (const [key, sel] of Object.entries(models)) {
		if (!sel || typeof sel !== "object") continue;
		const provider = typeof sel.provider === "string" ? sel.provider : "";
		const id = typeof sel.id === "string" ? sel.id : "";
		if (!provider && !id) continue;
		refs.push({ scope: key, ref: provider ? `${provider}/${id}` : id });
	}
	return refs;
}

/**
 * Validate one model reference against the registry.
 * `requireVision` additionally requires the model to accept image input
 * (used for visionFallback entries — a model that can't see images is
 * useless there even if it resolves).
 */
export function validateModelRef(
	registry: CheckRegistry,
	ref: string,
	requireVision = false,
): { ok: boolean; reason?: string } {
	const { modelRef } = stripThinkingLevel(ref);
	const model = findModelByRef(registry, modelRef);
	if (!model) return { ok: false, reason: `model not found: "${modelRef}"` };
	const auth = registry.getProviderAuthStatus(model.provider);
	if (!auth || !auth.configured) {
		return {
			ok: false,
			reason: `provider "${model.provider}" not authenticated`,
		};
	}
	if (requireVision && !model.input.includes("image")) {
		return { ok: false, reason: `model "${model.id}" has no image input` };
	}
	return { ok: true };
}

/** Run all static checks; returns entries grouped per source, invalid first. */
export function checkModels(
	registry: CheckRegistry,
	config: {
		/** config.json visionFallback.models array. */
		visionModels?: readonly string[];
		stateModels?: Record<string, { provider: string; id: string }>;
	},
): CheckResult {
	const result: CheckResult = { valid: [], invalid: [] };

	for (const { ref, index } of collectVisionRefs(config.visionModels)) {
		const entry: ModelRefEntry = {
			source: "config",
			scope: `visionFallback[${index}]`,
			ref,
		};
		const { ok, reason } = validateModelRef(registry, ref, true);
		if (ok) result.valid.push(entry);
		else result.invalid.push({ ...entry, reason: reason! });
	}

	for (const { scope, ref } of collectStateRefs(config.stateModels)) {
		const entry: ModelRefEntry = { source: "state", scope, ref };
		const { ok, reason } = validateModelRef(registry, ref);
		if (ok) result.valid.push(entry);
		else result.invalid.push({ ...entry, reason: reason! });
	}

	return result;
}

/** Human-readable summary of invalid references, or undefined when clean. */
export function formatInvalidSummary(
	invalid: CheckResult["invalid"],
): string | undefined {
	if (invalid.length === 0) return undefined;
	const lines = invalid.map((x) => `${x.source}→${x.scope} (${x.reason})`);
	return `${invalid.length} invalid:\n${lines.join("\n")}`;
}
