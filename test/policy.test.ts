import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Denial } from "../denials.ts";
import { checkPatternShape, ruleConflicts, sanitisePattern, suggestPattern, writeRule } from "../policy.ts";

const denial = (surface: string, value: string): Denial => ({
	requestId: "r",
	ts: 0,
	surface,
	toolName: surface,
	value,
	matchedPattern: "*",
	decidedByKind: "authorizer",
	decidedByName: "permission-judge",
	reason: "denied",
	overridable: true,
});

const bash = denial("bash", "git worktree remove ~/code/oa-wt-ci-965c");

function config(permission: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "ppr-"));
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ permission }, null, 2));
	return path;
}

describe("sanitisePattern", () => {
	it("accepts a multi-word prefix (the git worktree remove * bug)", () => {
		assert.deepEqual(sanitisePattern(bash, "git worktree remove *"), { ok: true, pattern: "git worktree remove *" });
		assert.equal(sanitisePattern(bash, "git worktree *").ok, true);
		assert.equal(sanitisePattern(bash, bash.value).ok, true);
	});
	it("rejects patterns that do not match or have a wildcard first word", () => {
		assert.equal(sanitisePattern(bash, "git worktree add *").ok, false);
		assert.equal(sanitisePattern(bash, "*").ok, false);
		assert.equal(sanitisePattern(bash, "g* *").ok, false);
	});
	it("accepts a pattern that covers one unit of a chain", () => {
		assert.equal(sanitisePattern(denial("bash", "cd ~/code && git worktree remove x"), "git worktree remove *").ok, true);
	});
	it("keeps path rules exact", () => {
		const path = denial("path", "/etc/hosts");
		assert.equal(sanitisePattern(path, "/etc/hosts").ok, true);
		assert.equal(sanitisePattern(path, "/etc/*").ok, false);
	});
	it("suggests the narrow subcommand pattern", () => {
		assert.equal(suggestPattern(bash), "git worktree remove *");
		assert.equal(suggestPattern(denial("path", "/etc/hosts")), "/etc/hosts");
	});
	it("checks shape without a denial", () => {
		assert.equal(checkPatternShape("bash", "git *").ok, true);
		assert.equal(checkPatternShape("bash", "*").ok, false);
		assert.equal(checkPatternShape("mcp", "*").ok, false);
	});
});

describe("writeRule", () => {
	it("appends the rule last so it wins, and keeps one backup", () => {
		const path = config({ bash: { "*": "ask", "git worktree remove *": "ask", "sudo *": "deny" } });
		const result = writeRule(path, bash, "git worktree remove *");
		assert.deepEqual(result, { ok: true, key: "bash", pattern: "git worktree remove *" });
		const written = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(Object.entries(written.permission.bash).at(-1), ["git worktree remove *", "allow"]);
		assert.ok(readFileSync(`${path}.bak`, "utf8").includes('"ask"'));
	});
	it("refuses to rewrite a config with comments", () => {
		const path = config({});
		writeFileSync(path, '{\n  // mine\n  "permission": {}\n}\n');
		const result = writeRule(path, bash, "git worktree remove *");
		assert.equal(result.ok, false);
		assert.match((result as { error: string }).error, /comments/);
		assert.ok(readFileSync(path, "utf8").includes("// mine"));
	});
	it("refuses an invalid pattern", () => {
		assert.equal(writeRule(config({}), bash, "*").ok, false);
	});
});

describe("ruleConflicts", () => {
	it("warns when an allow overlaps a deny", () => {
		const path = config({ bash: { "sudo *": "deny", "git push --force *": "deny" } });
		assert.equal(ruleConflicts(path, denial("bash", "sudo apt install x"), "sudo apt *").length, 1);
		assert.equal(ruleConflicts(path, denial("bash", "git push --force o"), "git push *").length, 1);
		assert.deepEqual(ruleConflicts(path, bash, "git worktree remove *"), []);
	});
	it("warns when an exact command holds wildcard characters", () => {
		const path = config({});
		assert.equal(ruleConflicts(path, denial("bash", "ls *.py"), "ls *.py").length, 1);
	});
});
