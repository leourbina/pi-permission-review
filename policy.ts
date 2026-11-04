/**
 * Policy writes: the escape hatch for denials an authorizer link cannot lift.
 *
 * A `policy` denial is decided before any chain link runs, and
 * pi-permission-system refuses to let a link allow the `path` and
 * `external_directory` surfaces at all. Those denials therefore need a real
 * rule in the policy config, which only takes effect after a reload, and the
 * retry has to survive that reload — hence `pending-retry.json`.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Denial } from "./denials.ts";

export type RuleResult =
	| { ok: true; key: string; pattern: string }
	| { ok: false; error: string };

export type PendingRetry = {
	value: string;
	toolName: string | null;
	surface: string;
	at: number;
};

/** The policy key a denial's surface writes into. */
export function policyKeyForSurface(surface: string): "bash" | "path" | "external_directory" | "skill" | "mcp" {
	if (surface === "bash") return "bash";
	if (surface === "path" || surface.startsWith("path_")) return "path";
	if (surface === "external_directory" || surface.startsWith("external_directory_")) {
		return "external_directory";
	}
	if (surface === "skill" || surface.startsWith("skill_")) return "skill";
	return "mcp";
}

/**
 * The only patterns this extension will ever write:
 *  - bash: the exact command, or a single leading token plus ` *`
 *  - filesystem surfaces: the exact path, never a glob
 *  - mcp/skill: the exact tool or skill name
 */
export function sanitisePattern(denial: Denial, candidate: string): { ok: true; pattern: string } | { ok: false; error: string } {
	const pattern = candidate.trim();
	if (!pattern) return { ok: false, error: "pattern is empty" };

	const key = policyKeyForSurface(denial.surface);
	if (key === "path" || key === "external_directory") {
		if (pattern !== denial.value) {
			return { ok: false, error: "path rules must name the exact path, not a pattern" };
		}
		return { ok: true, pattern };
	}
	if (key === "bash") {
		if (pattern === denial.value) return { ok: true, pattern };
		const match = /^(\S+) \*$/.exec(pattern);
		if (!match) return { ok: false, error: "use the exact command, or one word plus ' *'" };
		const head = match[1] ?? "";
		if (!denial.value.startsWith(`${head} `) && denial.value !== head) {
			return { ok: false, error: `'${head}' is not the first word of this command` };
		}
		return { ok: true, pattern };
	}
	return { ok: true, pattern };
}

/** Suggest the narrowest useful pattern for a denial. */
export function suggestPattern(denial: Denial): string {
	const key = policyKeyForSurface(denial.surface);
	if (key === "path" || key === "external_directory" || key === "skill" || key === "mcp") {
		return denial.value;
	}
	const first = denial.value.trim().split(/\s+/)[0];
	const rest = denial.value.trim().slice(first.length);
	return rest ? `${first} *` : denial.value;
}

/**
 * Add an allow rule and return the key that now holds it. The config is
 * backed up first, and only valid JSON is ever written.
 */
export function writeRule(configPath: string, denial: Denial, pattern: string): RuleResult {
	const checked = sanitisePattern(denial, pattern);
	if (!checked.ok) return { ok: false, error: checked.error };

	let config: Record<string, unknown>;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		return { ok: false, error: `cannot read policy config: ${(error as Error).message}` };
	}

	const permission = (config.permission ?? {}) as Record<string, unknown>;
	const key = policyKeyForSurface(denial.surface);
	const section = (permission[key] ?? {}) as Record<string, unknown>;
	section[checked.pattern] = "allow";
	permission[key] = section;
	config.permission = permission;

	try {
		copyFileSync(configPath, `${configPath}.bak.${Date.now()}`);
		mkdirSync(dirname(configPath), { recursive: true });
		const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		// Validate the bytes before they replace the live config.
		JSON.parse(readFileSync(tmp, "utf8"));
		renameSync(tmp, configPath);
	} catch (error) {
		return { ok: false, error: `cannot write policy config: ${(error as Error).message}` };
	}

	return { ok: true, key, pattern: checked.pattern };
}

export function pendingRetryPath(agentDir: string): string {
	return join(agentDir, "permission-review/pending-retry.json");
}

export function writePendingRetry(agentDir: string, retry: PendingRetry): void {
	const path = pendingRetryPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(retry, null, 2)}\n`, "utf8");
}

export function clearPendingRetry(agentDir: string): void {
	try {
		rmSync(pendingRetryPath(agentDir));
	} catch {
		// already gone
	}
}

/** A pending retry older than this is stale: the reload never happened. */
export const PENDING_RETRY_MAX_AGE_MS = 60_000;

export function takePendingRetry(agentDir: string, now: number): PendingRetry | null {
	const path = pendingRetryPath(agentDir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as PendingRetry;
		if (typeof parsed.at !== "number" || now - parsed.at > PENDING_RETRY_MAX_AGE_MS) {
			clearPendingRetry(agentDir);
			return null;
		}
		clearPendingRetry(agentDir);
		return parsed;
	} catch {
		clearPendingRetry(agentDir);
		return null;
	}
}

/** The exact retry sentence sent to the model. */
export function retryMessage(toolName: string | null, value: string): string {
	const call = toolName ? `${toolName} ${value}` : value;
	return `Retry the call you just attempted: ${call}`;
}
