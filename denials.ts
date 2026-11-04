/**
 * Denial reader: turns pi-permission-system's review log into the rows the
 * /permissions panel shows.
 *
 * The log is append-only JSONL and can grow large, so only its tail is read.
 * Every line is parsed defensively: a truncated final line or a foreign event
 * must never break the panel.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Tail window: 512 KiB is far more than one session's decisions. */
const TAIL_BYTES = 512 * 1024;

export type Denial = {
	requestId: string;
	/** Milliseconds since the epoch, from the event timestamp. */
	ts: number;
	surface: string;
	toolName: string | null;
	/** The gated value: command, path, skill name, or tool name. */
	value: string;
	matchedPattern: string | null;
	/** "policy" | "authorizer" | "user" — the decider that refused. */
	decidedByKind: string;
	decidedByName: string | null;
	reason: string;
	/** Only an authorizer denial can be lifted by a chain link. */
	overridable: boolean;
};

type RawEvent = Record<string, unknown>;

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readTail(path: string): string[] {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const length = size - start;
		if (length <= 0) return [];
		const buffer = Buffer.alloc(length);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, length, start);
		const text = buffer.toString("utf8");
		const lines = text.split("\n");
		// The first line is likely a partial record when we started mid-file.
		return start > 0 ? lines.slice(1) : lines;
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function toDenial(event: RawEvent): Denial | null {
	if (event.event !== "permission_request.denied") return null;

	const decidedBy = (event.decidedBy ?? {}) as Record<string, unknown>;
	const request = (event.payload as Record<string, unknown> | undefined)?.["request"] as
		| Record<string, unknown>
		| undefined;

	const surface = asString(event.surface) ?? asString(request?.["surface"]) ?? "unknown";
	const toolName = asString(event.toolName) ?? asString(request?.["toolName"]);
	const value =
		asString(event.command) ??
		asString(event.path) ??
		asString(event.target) ??
		asString(event.value) ??
		asString(request?.["value"]) ??
		"";

	const kind = asString(decidedBy.kind) ?? "unknown";
	const reason =
		asString(event.denialReason) ??
		asString(decidedBy.reason) ??
		(kind === "policy" ? "denied by policy" : "denied");

	const stamp = asString(event.timestamp);
	const parsed = stamp ? Date.parse(stamp) : Number.NaN;

	return {
		requestId: asString(event.requestId) ?? "",
		ts: Number.isFinite(parsed) ? parsed : 0,
		surface,
		toolName,
		value,
		matchedPattern: asString(event.matchedPattern),
		decidedByKind: kind,
		decidedByName: asString(decidedBy.name),
		reason,
		overridable: kind === "authorizer",
	};
}

/**
 * Recent denials, newest first, deduped by (surface, value).
 *
 * @param sinceMs   Only include events at or after this time. `null` keeps the
 *                  whole tail window.
 * @param sessionId When set, only denials recorded by that session. The log is
 *                  shared by every pi session on this machine, so without this
 *                  the panel shows other sessions' refusals.
 */
export function readDenials(
	logPath: string,
	sinceMs: number | null,
	limit = 25,
	sessionId?: string,
): Denial[] {
	const seen = new Set<string>();
	const denials: Denial[] = [];

	for (const line of readTail(logPath)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: RawEvent;
		try {
			event = JSON.parse(trimmed) as RawEvent;
		} catch {
			continue;
		}
		const denial = toDenial(event);
		if (!denial) continue;
		if (sessionId !== undefined) {
			if (event.sessionId !== sessionId) continue;
		} else if (sinceMs !== null && denial.ts < sinceMs) continue;
		const key = `${denial.surface}\u0000${denial.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		denials.push(denial);
	}

	denials.sort((left, right) => right.ts - left.ts);
	return denials.slice(0, limit);
}

/** The values this tab needs to count how often a remembered rule fires. */
export function denialValues(denials: Denial[]): string[] {
	return denials.map((denial) => denial.value);
}

/** Local wall-clock label for a denial row. */
export function timeLabel(ts: number): string {
	if (!ts) return "--:--";
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Surfaces a chain link is forbidden from allowing, whatever the store says. */
export function isLinkExcludedSurface(surface: string): boolean {
	return (
		surface === "path" ||
		surface === "external_directory" ||
		surface.startsWith("path_") ||
		surface.startsWith("external_directory_")
	);
}
