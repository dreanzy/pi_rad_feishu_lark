import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Redirect HOME to a scratch dir before gateway-lock.js is loaded — it
 * resolves locks.json at module scope. Never let this test touch the real
 * ~/.pi/agent/locks.json.
 */
const mockHome = vi.hoisted(
	() =>
		`${(process.env.TEMP ?? process.env.TMP ?? ".").replace(/\\/g, "/")}/rad-lark-lock-test-${process.pid}`,
);

vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => mockHome,
}));

const LOCKS_PATH = `${mockHome}/.pi/agent/locks.json`;

const { cleanupStaleLockOnStartup } = await import(
	"../extensions/gateway-lock.js"
);

function readLocks() {
	return JSON.parse(readFileSync(LOCKS_PATH, "utf8")) as Record<string, unknown>;
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid!;
	await new Promise((resolve) => child.on("exit", resolve));
	return pid;
}

describe("cleanupStaleLockOnStartup", () => {
	afterAll(() => rmSync(mockHome, { recursive: true, force: true }));

	it("evicts legacy and our own dead entries, keeps the live owner", async () => {
		const [deadA, deadB] = [await deadPid(), await deadPid()];
		mkdirSync(`${mockHome}/.pi/agent`, { recursive: true });
		writeFileSync(
			LOCKS_PATH,
			JSON.stringify({
				// Pre-rename key, owner long gone.
				"pi-feishu-lark.feishu-gateway": {
					pid: deadA,
					heartbeatAt: new Date().toISOString(),
				},
				// Current key, owner gone too.
				"rad-feishu-lark.feishu-gateway": {
					key: "rad-feishu-lark.feishu-gateway",
					pid: deadB,
					token: "dead-token",
					cwd: ".",
					startedAt: new Date().toISOString(),
					heartbeatAt: new Date().toISOString(),
					status: "connected",
				},
				// Some other plugin's lock must survive untouched.
				"other-plugin.lock": { pid: deadA },
			}),
			"utf8",
		);

		await cleanupStaleLockOnStartup();

		const locks = readLocks();
		expect(Object.keys(locks)).toEqual(["other-plugin.lock"]);
	});

	it("keeps a live owner with a fresh heartbeat", async () => {
		writeFileSync(
			LOCKS_PATH,
			JSON.stringify({
				"rad-feishu-lark.feishu-gateway": {
					key: "rad-feishu-lark.feishu-gateway",
					pid: process.pid,
					token: "live-token",
					cwd: ".",
					startedAt: new Date().toISOString(),
					heartbeatAt: new Date().toISOString(),
					status: "connected",
				},
			}),
			"utf8",
		);

		await cleanupStaleLockOnStartup();

		expect(Object.keys(readLocks())).toEqual(["rad-feishu-lark.feishu-gateway"]);
	});

	it("evicts an entry whose heartbeat is stale even though the pid is alive", async () => {
		writeFileSync(
			LOCKS_PATH,
			JSON.stringify({
				"rad-feishu-lark.feishu-gateway": {
					key: "rad-feishu-lark.feishu-gateway",
					pid: process.pid,
					token: "stale-heartbeat",
					cwd: ".",
					startedAt: new Date(Date.now() - 600_000).toISOString(),
					heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
					status: "connected",
				},
			}),
			"utf8",
		);

		await cleanupStaleLockOnStartup();

		expect(Object.keys(readLocks())).toEqual([]);
	});

	it("is a no-op when the file is missing or empty", async () => {
		rmSync(LOCKS_PATH, { force: true });
		await expect(cleanupStaleLockOnStartup()).resolves.toBeUndefined();

		writeFileSync(LOCKS_PATH, JSON.stringify({}), "utf8");
		await expect(cleanupStaleLockOnStartup()).resolves.toBeUndefined();
		expect(Object.keys(readLocks())).toEqual([]);
	});
});
