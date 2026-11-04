/**
 * Approval store: exact calls and wildcard patterns that the review-approvals
 * authorizer link is allowed to let through.
 *
 * Two lifetimes live here:
 *  - the session set, held in memory and cleared on `session_shutdown`
 *  - the persisted store in `approvals.json`, read fresh per ask
 *
 * The matcher mirrors pi-permission-system's own wildcard semantics: `*`
 * matches zero or more of any character, including path separators.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type ApprovalEntry = {
	/** Gate surface the approval applies to: "bash", "read", "path", … */
	surface: string;
	/** Exact value, or a `*` pattern, depending on the list it lives in. */
	value: string;
	createdAt: string;
	/** "session" approvals only apply to the session that granted them. */
	scope?: "session" | "always";
	/** Set for session-scoped approvals; absent means "always". */
	sessionId?: string;
};

export type Approvals = {
	exact: ApprovalEntry[];
	patterns: ApprovalEntry[];
};

export type ApprovalKind = "exact" | "pattern";

export function emptyApprovals(): Approvals {
	return { exact: [], patterns: [] };
}

function isEntry(value: unknown): value is ApprovalEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.surface === "string" &&
		typeof entry.value === "string" &&
		typeof entry.createdAt === "string"
	);
}

/** Read the store, treating anything unreadable or malformed as empty. */
export function readApprovals(path: string): Approvals {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return emptyApprovals();
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const exact = Array.isArray(parsed.exact) ? parsed.exact.filter(isEntry) : [];
		const patterns = Array.isArray(parsed.patterns) ? parsed.patterns.filter(isEntry) : [];
		return { exact, patterns };
	} catch {
		return emptyApprovals();
	}
}

/** Write the store atomically: a temp file in the same directory, then rename. */
export function writeApprovals(path: string, approvals: Approvals): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function removeApprovalsFile(path: string): void {
	try {
		rmSync(path);
	} catch {
		// already gone
	}
}

/** `git *` -> /^git .*$/ ; every other regex metacharacter is literal. */
export function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function entryMatches(entry: ApprovalEntry, surface: string, value: string): boolean {
	if (entry.surface !== surface) return false;
	return entry.value.includes("*") ? wildcardToRegExp(entry.value).test(value) : entry.value === value;
}

export function matches(approvals: Approvals, surface: string, value: string, sessionId?: string): boolean {
	const applies = (entry: ApprovalEntry): boolean =>
		entry.scope !== "session" || (sessionId !== undefined && entry.sessionId === sessionId);
	return (
		approvals.exact.some((entry) => applies(entry) && entryMatches(entry, surface, value)) ||
		approvals.patterns.some((entry) => applies(entry) && entryMatches(entry, surface, value))
	);
}

/** Drop session-scoped approvals that belonged to sessions other than this one. */
export function pruneOtherSessions(approvals: Approvals, sessionId: string): Approvals {
	const keep = (entry: ApprovalEntry): boolean =>
		entry.scope !== "session" || entry.sessionId === sessionId;
	return {
		exact: approvals.exact.filter(keep),
		patterns: approvals.patterns.filter(keep),
	};
}

/** Session-scoped entries that belong to the given session. */
export function sessionEntries(approvals: Approvals, sessionId: string): ApprovalEntry[] {
	const mine = (entry: ApprovalEntry): boolean =>
		entry.scope === "session" && entry.sessionId === sessionId;
	return [...approvals.exact.filter(mine), ...approvals.patterns.filter(mine)];
}

export function addEntry(
	approvals: Approvals,
	kind: ApprovalKind,
	surface: string,
	value: string,
	extra?: { scope?: "session" | "always"; sessionId?: string },
): Approvals {
	const list = kind === "exact" ? approvals.exact : approvals.patterns;
	if (list.some((entry) => entry.surface === surface && entry.value === value && entry.sessionId === extra?.sessionId)) {
		return approvals;
	}
	const entry: ApprovalEntry = {
		surface,
		value,
		createdAt: new Date().toISOString(),
		...(extra?.scope ? { scope: extra.scope } : {}),
		...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
	};
	return kind === "exact"
		? { ...approvals, exact: [entry, ...approvals.exact] }
		: { ...approvals, patterns: [entry, ...approvals.patterns] };
}

export function deleteEntry(approvals: Approvals, kind: ApprovalKind, surface: string, value: string): Approvals {
	const drop = (list: ApprovalEntry[]) =>
		list.filter((entry) => !(entry.surface === surface && entry.value === value));
	return kind === "exact"
		? { ...approvals, exact: drop(approvals.exact) }
		: { ...approvals, patterns: drop(approvals.patterns) };
}

/**
 * How many of the given values an entry covers. Used by the Remembered tab so
 * an over-broad pattern is visible before it bites.
 */
export function countMatches(entry: ApprovalEntry, values: string[]): number {
	return values.filter((value) => entryMatches(entry, entry.surface, value)).length;
}

/** Session-scoped approvals: exact (surface, value) pairs. */
export class SessionApprovals {
	private readonly keys = new Set<string>();

	private static key(surface: string, value: string): string {
		return `${surface}\u0000${value}`;
	}

	add(surface: string, value: string): void {
		this.keys.add(SessionApprovals.key(surface, value));
	}

	has(surface: string, value: string): boolean {
		return this.keys.has(SessionApprovals.key(surface, value));
	}

	clear(): void {
		this.keys.clear();
	}

	get size(): number {
		return this.keys.size;
	}

	values(): { surface: string; value: string }[] {
		return [...this.keys].map((key) => {
			const [surface, value] = key.split("\u0000");
			return { surface: surface ?? "", value: value ?? "" };
		});
	}
}
