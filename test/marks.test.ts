import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Denial } from "../denials.ts";
import { commitPlan, emptyMarks, footerLine, markSuffix, retryAllMessage, toggleApprove, toggleRetry } from "../marks.ts";

const denial = (value: string, overridable = true): Denial => ({
	requestId: value,
	ts: 0,
	surface: "bash",
	toolName: "bash",
	value,
	matchedPattern: null,
	decidedByKind: overridable ? "authorizer" : "policy",
	decidedByName: null,
	reason: "denied",
	overridable,
});

const rows = [denial("ls"), denial("pwd"), denial("rm -rf x", false)];

describe("marks", () => {
	it("enter toggles an approve mark and clears a retry mark", () => {
		let marks = toggleApprove(emptyMarks(), rows, 0);
		assert.deepEqual([...marks.approved], [0]);
		marks = toggleRetry(marks, rows, 1);
		marks = toggleApprove(marks, rows, 1);
		assert.deepEqual([...marks.approved].sort(), [0]);
		assert.equal(marks.retry.size, 0);
		marks = toggleApprove(marks, rows, 0);
		assert.equal(marks.approved.size, 0);
	});

	it("r toggles a retry mark, which also approves; un-marking retry keeps the approval", () => {
		let marks = toggleRetry(emptyMarks(), rows, 0);
		assert.ok(marks.retry.has(0) && marks.approved.has(0));
		marks = toggleRetry(marks, rows, 0);
		assert.ok(!marks.retry.has(0) && marks.approved.has(0));
	});

	it("marks several rows at once", () => {
		const marks = toggleRetry(toggleRetry(emptyMarks(), rows, 0), rows, 1);
		assert.equal(marks.retry.size, 2);
	});

	it("refuses to mark a row no link can lift", () => {
		assert.equal(toggleApprove(emptyMarks(), rows, 2).approved.size, 0);
		assert.equal(toggleRetry(emptyMarks(), rows, 2).retry.size, 0);
	});

	it("labels each row like Claude Code", () => {
		const marks = toggleApprove(toggleRetry(emptyMarks(), rows, 0), rows, 1);
		assert.equal(markSuffix(marks, rows, 0), " (retry)");
		assert.equal(markSuffix(marks, rows, 1), " (approved)");
		assert.equal(markSuffix(marks, rows, 2), " (can't be approved)");
	});

	it("says what esc will do", () => {
		assert.equal(footerLine(emptyMarks(), false), "");
		const approved = toggleApprove(toggleApprove(emptyMarks(), rows, 0), rows, 1);
		assert.equal(footerLine(approved, false), "esc will approve 2 blocked calls");
		const retry = toggleRetry(approved, rows, 0);
		assert.equal(footerLine(retry, false), "esc will retry 1 blocked call");
		assert.equal(footerLine(retry, true), "esc will tell the agent about 1 blocked call after this turn");
	});

	it("plans the commit: every approved row, and the retry subset", () => {
		const marks = toggleApprove(toggleRetry(emptyMarks(), rows, 1), rows, 0);
		const plan = commitPlan(marks, rows);
		assert.deepEqual(
			plan.approved.map((item) => item.value),
			["ls", "pwd"],
		);
		assert.deepEqual(
			plan.retry.map((item) => item.value),
			["pwd"],
		);
	});

	it("asks for every retry in one message", () => {
		assert.equal(retryAllMessage([denial("ls")]), "Retry the call you just attempted: bash ls");
		const text = retryAllMessage([denial("ls"), denial("pwd")]);
		assert.match(text, /^Retry these 2 calls/);
		assert.match(text, /\n- bash ls\n- bash pwd$/);
	});
});
