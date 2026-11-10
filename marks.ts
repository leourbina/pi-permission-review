/**
 * Batch marks on the Denied tab, modelled on Claude Code's "Recently blocked"
 * review: enter toggles an approve mark, `r` toggles a retry mark (which also
 * approves), and nothing happens until esc, which applies every mark at once.
 */

import type { Denial } from "./denials.ts";
import { retryMessage } from "./policy.ts";

export type Marks = { approved: ReadonlySet<number>; retry: ReadonlySet<number> };

export function emptyMarks(): Marks {
	return { approved: new Set(), retry: new Set() };
}

/** A row the review link cannot lift (a policy denial) takes no mark. */
function markable(denials: readonly Denial[], index: number): boolean {
	return denials[index]?.overridable === true;
}

function without(set: ReadonlySet<number>, index: number): Set<number> {
	const next = new Set(set);
	next.delete(index);
	return next;
}

function toggled(set: ReadonlySet<number>, index: number): Set<number> {
	const next = new Set(set);
	if (next.has(index)) next.delete(index);
	else next.add(index);
	return next;
}

/** Enter: flip the approve mark; any retry mark on the row is dropped. */
export function toggleApprove(marks: Marks, denials: readonly Denial[], index: number): Marks {
	if (!markable(denials, index)) return marks;
	return { approved: toggled(marks.approved, index), retry: without(marks.retry, index) };
}

/** r: flip the retry mark. Retrying implies approving; un-marking keeps the approval. */
export function toggleRetry(marks: Marks, denials: readonly Denial[], index: number): Marks {
	if (!markable(denials, index)) return marks;
	const approved = new Set(marks.approved);
	approved.add(index);
	return { approved, retry: toggled(marks.retry, index) };
}

/** The dim suffix after a row's command. */
export function markSuffix(marks: Marks, denials: readonly Denial[], index: number): string {
	if (marks.retry.has(index)) return " (retry)";
	if (marks.approved.has(index)) return " (approved)";
	if (!markable(denials, index)) return " (can't be approved)";
	return "";
}

function calls(count: number): string {
	return `${count} blocked ${count === 1 ? "call" : "calls"}`;
}

/** What esc will do with the current marks; empty when nothing is marked. */
export function footerLine(marks: Marks, midTurn: boolean): string {
	if (marks.retry.size > 0) {
		return midTurn
			? `esc will tell the agent about ${calls(marks.retry.size)} after this turn`
			: `esc will retry ${calls(marks.retry.size)}`;
	}
	if (marks.approved.size > 0) return `esc will approve ${calls(marks.approved.size)}`;
	return "";
}

/** Rows to approve (every marked row) and the subset to retry, in list order. */
export function commitPlan(marks: Marks, denials: readonly Denial[]): { approved: Denial[]; retry: Denial[] } {
	const pick = (set: ReadonlySet<number>): Denial[] =>
		[...set].sort((a, b) => a - b).flatMap((index) => (markable(denials, index) ? [denials[index]!] : []));
	return { approved: pick(marks.approved), retry: pick(marks.retry) };
}

/** One message asking the agent to retry every marked call. */
export function retryAllMessage(denials: readonly Denial[]): string {
	if (denials.length === 1) {
		const [only] = denials;
		return retryMessage(only!.toolName, only!.value);
	}
	const list = denials.map((denial) => `- ${denial.toolName ? `${denial.toolName} ` : ""}${denial.value}`);
	return [`Retry these ${denials.length} calls, which were denied and are now approved:`, ...list].join("\n");
}
