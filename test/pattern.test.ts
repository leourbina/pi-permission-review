import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import {
	checkBashShape,
	commandUnits,
	coversCommand,
	isSimpleCommand,
	suggestBashPattern,
	wildcardMatch,
} from "../pattern.ts";

describe("wildcardMatch mirrors the gate", () => {
	it("matches across newlines", () => {
		assert.ok(wildcardMatch("python3 *", "python3 - <<EOF\nprint(1)\nEOF"));
	});
	it("lets a trailing ' *' match the bare command", () => {
		assert.ok(wildcardMatch("git *", "git"));
		assert.ok(!wildcardMatch("git *", "gitk"));
	});
	it("treats ? as one character", () => {
		assert.ok(wildcardMatch("ls ?", "ls a"));
		assert.ok(!wildcardMatch("ls ?", "ls ab"));
	});
	it("expands a leading ~ on the pattern only", () => {
		assert.ok(wildcardMatch("~/code/*", `${homedir()}/code/x`));
		assert.ok(!wildcardMatch("git -C ~/code *", `git -C ${homedir()}/code status`));
	});
	it("escapes regex metacharacters", () => {
		assert.ok(wildcardMatch("a.b (c) *", "a.b (c) d"));
		assert.ok(!wildcardMatch("a.b *", "axb c"));
	});
});

describe("isSimpleCommand", () => {
	it("accepts plain commands", () => {
		assert.ok(isSimpleCommand("git worktree remove ~/code/x"));
	});
	for (const chained of ["a && b", "a; b", "a | b", "a > f", "echo $(id)", "a\nb", "echo `id`"]) {
		it(`rejects ${JSON.stringify(chained)}`, () => assert.ok(!isSimpleCommand(chained)));
	}
});

describe("commandUnits", () => {
	it("splits on control operators", () => {
		assert.deepEqual(commandUnits("cd x && git worktree remove y | cat; ls"), [
			"cd x",
			"git worktree remove y",
			"cat",
			"ls",
		]);
	});
});

describe("suggestBashPattern", () => {
	it("uses the subcommand depth", () => {
		assert.equal(suggestBashPattern("git worktree remove ~/code/oa-wt-ci-965c"), "git worktree remove *");
		assert.equal(suggestBashPattern("git push origin main"), "git push *");
		assert.equal(suggestBashPattern("gh pr view 12 --json state"), "gh pr view *");
		assert.equal(suggestBashPattern("python3 m965.py"), "python3 *");
	});
	it("keeps a command with no arguments exact", () => {
		assert.equal(suggestBashPattern("python3"), "python3");
		assert.equal(suggestBashPattern("ps aux"), "ps *");
	});
	it("skips a leading cd", () => {
		assert.equal(suggestBashPattern("cd ~/code && git worktree remove x"), "git worktree remove *");
	});
});

describe("checkBashShape", () => {
	it("requires a literal first word", () => {
		assert.equal(checkBashShape("git worktree remove *"), null);
		assert.ok(checkBashShape("*"));
		assert.ok(checkBashShape("g* foo"));
		assert.ok(checkBashShape("? *"));
		assert.ok(checkBashShape("  "));
	});

	it("allows * only at the end, since an inner * spans arguments", () => {
		// `git -C * push *` would also match `git -C . config core.pager <prog> push`.
		assert.ok(checkBashShape("git -C * push *"));
		assert.ok(checkBashShape("git * status"));
		assert.equal(checkBashShape("git status*"), null);
		assert.equal(checkBashShape("npm run test:*"), null);
		assert.equal(checkBashShape("git log -?"), null);
	});
});

describe("coversCommand", () => {
	it("matches the whole command or one unit", () => {
		assert.ok(coversCommand("git worktree remove *", "git worktree remove x"));
		assert.ok(coversCommand("git worktree remove *", "cd ~/code && git worktree remove x"));
		assert.ok(!coversCommand("git worktree add *", "git worktree remove x"));
	});
});
