import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { debugLog } from "./debug.js";
import { withFileLock } from "./utils.js";

const LOCK_KEY = "rad-feishu-lark.feishu-gateway";
/** Keys left behind by the pre-rename plugin name. */
const LEGACY_LOCK_KEYS = ["pi-feishu-lark.feishu-gateway"];
const LOCKS_PATH = join(homedir(), ".pi", "agent", "locks.json");
const LOCK_STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
// Must stay well above the status-bar refresh interval (2s), or every refresh
// misses the cache and pays a process probe.
const PROCESS_ALIVE_CACHE_TTL_MS = 15_000;
/** Stale entries are only rewritten to disk this often, per process. */
const STALE_CLEANUP_COOLDOWN_MS = 30_000;
const processAliveCache = new Map<
	number,
	{ alive: boolean; checkedAt: number }
>();
/** Shared in-flight probes, so concurrent callers pay one probe per pid. */
const processAliveInflight = new Map<number, Promise<boolean>>();
let lastStaleCleanupAt = 0;

export type GatewayOwner = {
	key: typeof LOCK_KEY;
	pid: number;
	token: string;
	cwd: string;
	startedAt: string;
	heartbeatAt: string;
	status: "starting" | "connected" | "disconnected";
};

type LocksFile = Record<string, unknown>;

export type GatewayLockResult =
	| { status: "acquired"; handle: GatewayLockHandle }
	| { status: "busy"; owner: GatewayOwner };

export class GatewayLockHandle {
	private heartbeat: NodeJS.Timeout | undefined;
	private onLost: (() => void | Promise<void>) | undefined;

	constructor(readonly owner: GatewayOwner) {}

	setOnLost(handler: () => void | Promise<void>) {
		this.onLost = handler;
	}

	startHeartbeat() {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			this.update("connected").catch((error) => {
				debugLog("feishu.gateway.heartbeat_error", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	async update(status: GatewayOwner["status"]) {
		let lostOwnership = false;
		await withLocksFileLock(() => {
			const locks = readLocksFile();
			const current = asGatewayOwner(locks[LOCK_KEY]);
			if (
				!current ||
				current.token !== this.owner.token ||
				current.pid !== this.owner.pid
			) {
				this.stopHeartbeat();
				lostOwnership = true;
				return;
			}
			const next: GatewayOwner = {
				...current,
				heartbeatAt: new Date().toISOString(),
				status,
			};
			locks[LOCK_KEY] = next;
			writeLocksFile(locks);
		});
		if (lostOwnership) {
			debugLog("feishu.gateway.lock_lost", { pid: this.owner.pid });
			await this.onLost?.();
		}
	}

	async release() {
		this.stopHeartbeat();
		await withLocksFileLock(() => {
			const locks = readLocksFile();
			const current = asGatewayOwner(locks[LOCK_KEY]);
			if (current?.token === this.owner.token && current.pid === this.owner.pid) {
				delete locks[LOCK_KEY];
				writeLocksFile(locks);
				debugLog("feishu.gateway.lock_released", { pid: this.owner.pid });
			}
		});
	}

	private stopHeartbeat() {
		if (!this.heartbeat) return;
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}
}

export async function acquireGatewayLock(
	cwd: string,
	force = false,
): Promise<GatewayLockResult> {
	return withLocksFileLock(() => {
		const locks = readLocksFile();
		const existing = asGatewayOwner(locks[LOCK_KEY]);
		if (existing && !force && !isStale(existing)) {
			debugLog("feishu.gateway.lock_busy", {
				ownerPid: existing.pid,
				heartbeatAt: existing.heartbeatAt,
				currentPid: process.pid,
			});
			return { status: "busy", owner: existing };
		}

		const owner: GatewayOwner = {
			key: LOCK_KEY,
			pid: process.pid,
			token: randomToken(),
			cwd,
			startedAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
			status: "starting",
		};
		locks[LOCK_KEY] = owner;
		writeLocksFile(locks);
		debugLog("feishu.gateway.lock_acquired", {
			pid: owner.pid,
			cwd,
			replacedPid: existing?.pid,
			force,
		});
		return { status: "acquired", handle: new GatewayLockHandle(owner) };
	});
}

export function readGatewayOwner(): GatewayOwner | undefined {
	const owner = asGatewayOwner(readLocksFile()[LOCK_KEY]);
	return owner && !isStale(owner) ? owner : undefined;
}

/**
 * Async twin of readGatewayOwner, for the TUI status refresh: the Windows
 * process probe spawns tasklist (and possibly powershell), which costs
 * hundreds of ms and must not block the main thread.
 *
 * Also opportunistically drops dead entries from locks.json — they are
 * otherwise never evicted, so a crashed daemon leaves a record forever.
 * Throttled, because the periodic refresh runs every 2s.
 */
export async function readGatewayOwnerAsync(): Promise<
	GatewayOwner | undefined
> {
	const owner = asGatewayOwner(readLocksFile()[LOCK_KEY]);
	if (owner && !(await isStaleAsync(owner))) return owner;
	void cleanupStaleLock();
	return undefined;
}

/**
 * Drop lock entries whose owning process is gone: our own key, plus any key
 * left behind by the pre-rename plugin name.
 *
 * Call once per process start. Every host — including the headless daemon,
 * which never runs the TUI status refresh — has to do this, or a legacy key
 * survives forever and blocks the next daemon from taking the lock.
 * Failures are logged and left for the next periodic refresh.
 */
export async function cleanupStaleLockOnStartup(): Promise<void> {
	lastStaleCleanupAt = 0;
	await cleanupStaleLock();
}

/**
 * Probe-based eviction, so nothing here blocks the caller's thread. Cooldown-
 * gated because the TUI status refresh calls it every 2s.
 */
async function cleanupStaleLock(): Promise<void> {
	if (Date.now() - lastStaleCleanupAt < STALE_CLEANUP_COOLDOWN_MS) return;
	lastStaleCleanupAt = Date.now();
	try {
		const evictions = await findStaleLockKeys();
		if (!evictions.length) return;
		// Re-probe after taking the lock: the owner may have refreshed its
		// heartbeat while we were probing.
		await withLocksFileLock(async () => {
			const locks = readLocksFile();
			let changed = false;
			for (const key of evictions) {
				const owner = asLockEntry(locks[key]);
				if (!owner || !(await isStaleAsync(owner))) continue;
				delete locks[key];
				changed = true;
				debugLog("feishu.gateway.lock_evicted", { key, pid: owner.pid });
			}
			if (changed) writeLocksFile(locks);
		});
	} catch (error) {
		debugLog("feishu.gateway.lock_cleanup_failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Keys that currently hold a stale entry, probed outside the file lock. */
async function findStaleLockKeys(): Promise<string[]> {
	const locks = readLocksFile();
	const candidates = [LOCK_KEY, ...LEGACY_LOCK_KEYS];
	const stale: string[] = [];
	for (const key of candidates) {
		const owner = asLockEntry(locks[key]);
		// Unparseable entries are leftovers by definition — evict them too.
		if (!owner || (await isStaleAsync(owner))) stale.push(key);
	}
	return stale;
}

/**
 * Minimum shape an eviction candidate must have. Deliberately looser than
 * asGatewayOwner: legacy entries carry the pre-rename key, so they fail that
 * check, and a malformed entry is exactly what wants deleting.
 */
function asLockEntry(value: unknown): StaleCheckable | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Partial<GatewayOwner>;
	if (typeof raw.pid !== "number" || typeof raw.heartbeatAt !== "string")
		return undefined;
	return { pid: raw.pid, heartbeatAt: raw.heartbeatAt };
}

export function gatewayLockPath() {
	return LOCKS_PATH;
}

function asGatewayOwner(value: unknown): GatewayOwner | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Partial<GatewayOwner>;
	if (raw.key !== LOCK_KEY) return undefined;
	if (typeof raw.pid !== "number" || typeof raw.token !== "string")
		return undefined;
	if (
		typeof raw.cwd !== "string" ||
		typeof raw.startedAt !== "string" ||
		typeof raw.heartbeatAt !== "string"
	)
		return undefined;
	if (
		raw.status !== "starting" &&
		raw.status !== "connected" &&
		raw.status !== "disconnected"
	)
		return undefined;
	return raw as GatewayOwner;
}

/** What a staleness check needs — deliberately looser than GatewayOwner so
 * partially-valid entries can still be judged. */
type StaleCheckable = Pick<GatewayOwner, "pid" | "heartbeatAt">;

function isStale(owner: StaleCheckable) {
	if (!isProcessAlive(owner.pid)) return true;
	return isHeartbeatStale(owner);
}

async function isStaleAsync(owner: StaleCheckable) {
	if (!(await isProcessAliveAsync(owner.pid))) return true;
	return isHeartbeatStale(owner);
}

function isHeartbeatStale(owner: StaleCheckable) {
	const heartbeatAt = Date.parse(owner.heartbeatAt);
	if (!Number.isFinite(heartbeatAt)) return true;
	return Date.now() - heartbeatAt > LOCK_STALE_MS;
}

export function isProcessAlive(pid: number): boolean {
	return cachedProbeSync(pid, () => probeProcessAliveSync(pid));
}

/**
 * Async twin of isProcessAlive. Shares the cache with it, so a probe on one
 * path answers the other.
 */
export async function isProcessAliveAsync(pid: number): Promise<boolean> {
	return cachedProbeAsync(pid, probeProcessAliveAsync);
}

/**
 * A probe is invalid for any pid the OS could not report on. Both paths apply
 * this before touching the platform branch: they share one cache, so a
 * disagreement here (POSIX `kill(0, 0)` succeeds) would let whichever ran
 * last poison the answer for the other.
 */
function isProbeablePid(pid: number) {
	return Number.isFinite(pid) && pid > 0;
}

function readFreshCache(pid: number) {
	const cached = processAliveCache.get(pid);
	return cached && Date.now() - cached.checkedAt < PROCESS_ALIVE_CACHE_TTL_MS
		? cached.alive
		: undefined;
}

function cachedProbeAsync(
	pid: number,
	probe: (pid: number) => Promise<boolean>,
) {
	const cached = readFreshCache(pid);
	if (cached !== undefined) return Promise.resolve(cached);

	// An in-flight probe is joined rather than duplicated, sync or async — the
	// TUI refresh and a command handler often ask about the same pid at once.
	const inflight = processAliveInflight.get(pid);
	if (inflight) return inflight;

	const pending = probe(pid)
		.then((alive) => {
			processAliveCache.set(pid, { alive, checkedAt: Date.now() });
			return alive;
		})
		.finally(() => processAliveInflight.delete(pid));
	processAliveInflight.set(pid, pending);
	return pending;
}

function cachedProbeSync(pid: number, probe: () => boolean) {
	const cached = readFreshCache(pid);
	if (cached !== undefined) return cached;
	// No joining here: a sync caller cannot await an in-flight async probe. It
	// shares the cache with the async path, not the in-flight map, so the worst
	// case is one duplicate probe rather than a stale answer.
	const alive = probe();
	processAliveCache.set(pid, { alive, checkedAt: Date.now() });
	return alive;
}

async function probeProcessAliveAsync(pid: number): Promise<boolean> {
	if (!isProbeablePid(pid)) return false;
	if (!onWindows()) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	const tasklist = await execFileText("tasklist", tasklistArgs(pid));
	if (tasklist.ok) return tasklist.stdout.includes(String(pid));
	// tasklist unavailable (rare) — fall back to PowerShell.
	return (await execFileText(...powershellProbe(pid))).ok;
}

/**
 * Windows: Node.js v20+ process.kill(pid, 0) actually TERMINATES the target
 * process instead of just checking existence (TerminateProcess is used for
 * signal delivery on Windows, and signal 0 is not treated specially).
 * Use tasklist (with PowerShell fallback) for side-effect-free existence
 * checks. tasklist ships with every Windows version, unlike wmic which was
 * deprecated in Win 10 21H2+.
 */
function probeProcessAliveSync(pid: number): boolean {
	if (!isProbeablePid(pid)) return false;
	if (!onWindows()) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	if (hasProcessWindowsSync(pid)) return true;
	// tasklist unavailable (rare) — fall back to PowerShell.
	return powershellHasProcessSync(pid);
}

/**
 * tasklist is the primary probe: ~10ms versus ~310ms for powershell, and its
 * output is locale-independent — the "no tasks match" reply never contains
 * the queried PID, so a substring test is safe for both languages.
 */
function hasProcessWindowsSync(pid: number): boolean {
	try {
		const stdout = execFileSync("tasklist", tasklistArgs(pid), {
			...quietExec,
			encoding: "utf8",
		});
		return String(stdout).includes(String(pid));
	} catch {
		return false;
	}
}

function powershellHasProcessSync(pid: number): boolean {
	try {
		execFileSync(...powershellProbe(pid), quietExec);
		return true;
	} catch {
		return false;
	}
}

function tasklistArgs(pid: number) {
	return ["/FI", `PID eq ${pid}`, "/NH"];
}

function powershellProbe(pid: number): [string, string[]] {
	return [
		"powershell",
		[
			"-noprofile",
			"-command",
			`if(!(Get-Process -Id ${pid} -ErrorAction SilentlyContinue)){exit 1}`,
		],
	];
}

/**
 * Stderr is piped in both variants so localized (GBK) command errors never
 * leak into the TUI terminal as mojibake — this used to happen on every
 * status refresh.
 */
const quietExec: Record<string, unknown> = {
	timeout: 3000,
	windowsHide: true,
	stdio: ["ignore", "pipe", "pipe"],
};

function execFileText(file: string, args: string[]) {
	return new Promise<{ ok: boolean; stdout: string }>((resolve) => {
		execFile(
			file,
			args,
			{ timeout: 3000, windowsHide: true, encoding: "utf8" },
			(error, stdout) => {
				resolve({
					ok: !error,
					stdout: typeof stdout === "string" ? stdout : "",
				});
			},
		);
	});
}

function onWindows() {
	return process.platform === "win32";
}

function randomToken() {
	return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readLocksFile(): LocksFile {
	try {
		if (!existsSync(LOCKS_PATH)) return {};
		return JSON.parse(readFileSync(LOCKS_PATH, "utf8")) as LocksFile;
	} catch {
		return {};
	}
}

function writeLocksFile(locks: LocksFile) {
	mkdirSync(dirname(LOCKS_PATH), { recursive: true });
	writeFileSync(LOCKS_PATH, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
}

async function withLocksFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
	return withFileLock(`${LOCKS_PATH}.lock`, fn, {
		staleMs: LOCK_STALE_MS,
		onTimeout: (lockPath) =>
			debugLog("feishu.gateway.file_lock_timeout", { lockPath }),
	});
}
