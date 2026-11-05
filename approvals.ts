/**
 * Approval store: exact calls and wildcard patterns that the review-approvals
 * authorizer link is allowed to let through.
 *
 * Two lifetimes live here:
 *  - the session set, held in memory and cleared on `session_shutdown`
 *  - the persisted store in `approvals.json`, read fresh per ask
 *
 * Which list an entry lives in decides how it matches: `exact` entries compare
 * verbatim (a command with `?` in a URL is not a pattern), `patterns` use the
 * gate's own wildcard semantics (see pattern.ts).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { checkBashShape, isSimpleCommand, wildcardMatch } from "./pattern.ts";

export { wildcardToRegExp } from "./pattern.ts";

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

export function entryMatches(entry: ApprovalEntry, kind: ApprovalKind, surface: string, value: string): boolean {
	if (entry.surface !== surface) return false;
	if (kind === "exact") return entry.value === value;
	// The link sees the whole bash string; a pattern must not ride along on a
	// chained, piped or redirected command. Those defer to the judge instead.
	if (surface === "bash" && !isSimpleCommand(value)) return false;
	// A hand-edited or pre-1.1 entry may have a shape the editor now refuses
	// (an inner `*` spans arguments); it never matches.
	if (surface === "bash" && checkBashShape(entry.value) !== null) return false;
	return wildcardMatch(entry.value, value);
}

export function matches(approvals: Approvals, surface: string, value: string, sessionId?: string): boolean {
	const applies = (entry: ApprovalEntry): boolean =>
		entry.scope !== "session" || (sessionId !== undefined && entry.sessionId === sessionId);
	return (
		approvals.exact.some((entry) => applies(entry) && entryMatches(entry, "exact", surface, value)) ||
		approvals.patterns.some((entry) => applies(entry) && entryMatches(entry, "pattern", surface, value))
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
export function countMatches(entry: ApprovalEntry, kind: ApprovalKind, values: string[]): number {
	return values.filter((value) => entryMatches(entry, kind, entry.surface, value)).length;
}

/**
 * Replace a stored entry with a new value, keeping its scope and session. The
 * new value lands in `patterns` when it holds a wildcard, else in `exact`.
 */
export function replaceEntry(
	approvals: Approvals,
	kind: ApprovalKind,
	entry: ApprovalEntry,
	value: string,
): Approvals {
	const without = deleteEntry(approvals, kind, entry.surface, entry.value);
	const nextKind: ApprovalKind = value.includes("*") || value.includes("?") ? "pattern" : "exact";
	return addEntry(without, nextKind, entry.surface, value, {
		...(entry.scope ? { scope: entry.scope } : {}),
		...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
	});
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
