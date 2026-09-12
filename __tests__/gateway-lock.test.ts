import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	isProcessAlive,
	isProcessAliveAsync,
} from "../extensions/gateway-lock.js";

/** A pid that is guaranteed dead: a child we spawned and fully reaped. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid!;
	await new Promise((resolve) => child.on("exit", resolve));
	return pid;
}

describe("process probes", () => {
	it("detects a live process through both probes", async () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(await isProcessAliveAsync(process.pid)).toBe(true);
	});

	it("detects a dead process through both probes", async () => {
		const pid = await deadPid();
		expect(await isProcessAliveAsync(pid)).toBe(false);
		expect(await isProcessAliveAsync(pid)).toBe(false);
	});

	it("rejects nonsensical pids without spawning a probe", async () => {
		expect(await isProcessAliveAsync(0)).toBe(false);
		expect(await isProcessAliveAsync(-1)).toBe(false);
	});
});
