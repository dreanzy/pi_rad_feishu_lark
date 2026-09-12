import { describe, expect, it, vi, beforeAll } from "vitest";
import {
	checkModels,
	findModelByRef,
	stripThinkingLevel,
	validateModelRef,
	type CheckRegistry,
} from "../extensions/model-check.js";

vi.mock("@larksuiteoapi/node-sdk", () => ({}));
vi.mock("qrcode-terminal", () => ({}));

type OnHandler = (event: any, ctx: any) => void | Promise<void>;
const registeredCommands: string[] = [];
let sessionStartHandler: OnHandler | undefined;
let sessionShutdownHandler: OnHandler | undefined;

const mockPi = {
	on: vi.fn((event: string, handler: OnHandler) => {
		if (event === "session_start") sessionStartHandler = handler;
		if (event === "session_shutdown") sessionShutdownHandler = handler;
	}),
	registerCommand: vi.fn((name: string, _def: any) => {
		registeredCommands.push(name);
	}),
} as any;

beforeAll(async () => {
	const mod = await import("../extensions/index.js");
	mod.default(mockPi);
});

describe("model-check", () => {
	const registry: CheckRegistry = {
		getAll: () => [
			{
				provider: "command-code",
				id: "deepseek/deepseek-v4-flash",
				input: ["text", "image"],
			},
			{
				provider: "anthropic",
				id: "claude-sonnet-4",
				input: ["text"],
			},
			{
				provider: "openai",
				id: "gpt-text",
				input: ["text"],
			},
		],
		find: (provider, id) =>
			provider === "command-code" && id === "deepseek/deepseek-v4-flash"
				? ({
						provider,
						id,
						input: ["text", "image"],
					} as const)
				: provider === "anthropic" && id === "claude-sonnet-4"
					? ({
							provider,
							id,
							input: ["text"],
						} as const)
					: provider === "openai" && id === "gpt-text"
						? ({
								provider,
								id,
								input: ["text"],
							} as const)
						: undefined,
		getProviderAuthStatus: (provider) =>
			provider === "command-code" || provider === "openai"
				? { configured: true }
				: { configured: false },
	};

	it("strips known thinking levels, not arbitrary suffixes", () => {
		expect(stripThinkingLevel("a/b:high").modelRef).toBe("a/b");
		expect(stripThinkingLevel("a/b:off").modelRef).toBe("a/b");
		expect(stripThinkingLevel("a/b:weird").modelRef).toBe("a/b:weird");
		expect(stripThinkingLevel("a/b").modelRef).toBe("a/b");
	});

	it("resolves nested-id models with provider + bare fallback", () => {
		// provider "command-code", id "deepseek/deepseek-v4-flash"
		const found = findModelByRef(
			registry,
			"command-code/deepseek/deepseek-v4-flash",
		);
		expect(found?.id).toBe("deepseek/deepseek-v4-flash");

		// bare id without provider segment still resolves
		const bare = findModelByRef(registry, "deepseek/deepseek-v4-flash");
		expect(bare?.provider).toBe("command-code");

		// unknown stays unknown
		expect(findModelByRef(registry, "gone/ghost")).toBeUndefined();
	});

	it("flags unknown model, unauthenticated provider, and missing vision", () => {
		const unknown = validateModelRef(registry, "nope/nope");
		expect(unknown.ok).toBe(false);
		expect(unknown.reason).toContain("not found");

		// anthropic exists but auth missing
		const noAuth = validateModelRef(registry, "anthropic/claude-sonnet-4");
		expect(noAuth.ok).toBe(false);
		expect(noAuth.reason).toContain("not authenticated");

		// openai authenticated but can't see images
		const noVision = validateModelRef(registry, "openai/gpt-text", true);
		expect(noVision.ok).toBe(false);
		expect(noVision.reason).toContain("no image input");
	});

	it("collects state + config refs and reports only invalid", () => {
		const result = checkModels(registry, {
			visionModels: [
				"command-code/deepseek/deepseek-v4-flash:high",
				"anthropic/claude-sonnet-4",
				"gone/ghost",
			],
			stateModels: {
				"p2p:chat1": { provider: "command-code", id: "deepseek/deepseek-v4-flash" },
				"p2p:chat2": { provider: "command-code", id: "gone/ghost" },
			},
		});
		const invalidRefs = result.invalid.map((i) => i.ref);
		expect(invalidRefs).toEqual([
			"anthropic/claude-sonnet-4",
			"gone/ghost",
			"command-code/gone/ghost",
		]);
		expect(result.valid.length).toBe(2);
	});
});

describe("registration", () => {
	it("registers the feishu command", () => {
		expect(registeredCommands.some((c) => c.startsWith("feishu"))).toBe(true);
	});

	it("registers message_end handler", () => {
		const onCalls = mockPi.on.mock.calls.map((c: any[]) => c[0]);
		expect(onCalls).toContain("message_end");
		expect(onCalls).toContain("session_start");
		expect(onCalls).toContain("session_shutdown");
	});
});
