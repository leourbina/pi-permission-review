/**
 * The denial row the /permissions panel shows, and small helpers over it.
 *
 * Rows are built in index.ts from the gate's `permissions:decision`
 * broadcast, which is per-session by construction.
 */

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
