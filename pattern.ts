/**
 * Pattern semantics shared by the approval store and the policy writer.
 *
 * Everything here mirrors @gotgenes/pi-permission-system, so a pattern the
 * user writes means the same thing whether the gate or this extension's link
 * evaluates it:
 *  - `*` matches any run of characters, newlines and `/` included
 *  - `?` matches exactly one character
 *  - a trailing ` *` also matches the bare command (`git *` matches `git`)
 *  - a leading `~`, `$HOME` or `${HOME}` is expanded on the pattern only
 */

import { homedir } from "node:os";
import { join } from "node:path";

const HOME_PREFIXES = ["${HOME}", "$HOME", "~"];

/** Expand a leading home prefix, as the gate's `expandHomePath` does. */
export function expandHome(pattern: string, home: string = homedir()): string {
	for (const prefix of HOME_PREFIXES) {
		if (!pattern.startsWith(prefix)) continue;
		const rest = pattern.slice(prefix.length);
		if (rest === "") return home;
		if (rest.startsWith("/") || rest.startsWith("\\")) return join(home, rest.slice(1));
	}
	return pattern;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a gate-style wildcard pattern. */
export function wildcardToRegExp(pattern: string): RegExp {
	let escaped = expandHome(pattern)
		.split("*")
		.map((part) => escapeRegExp(part).replaceAll("\\?", "."))
		.join(".*");
	if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
	return new RegExp(`^${escaped}$`, "s");
}

export function wildcardMatch(pattern: string, value: string): boolean {
	return wildcardToRegExp(pattern).test(value);
}

export function hasWildcard(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?");
}

/**
 * Whether a bash command is a single plain command: no chaining, pipes,
 * redirects, or substitutions.
 *
 * The review link sees the whole command string, not the gate's parsed units,
 * so a remembered `git worktree remove *` would otherwise also cover
 * `git worktree remove x && curl … | sh`. This check is deliberately naive —
 * it ignores quoting — so it errs towards "not simple", which only means the
 * pattern defers to the judge instead of allowing.
 */
export function isSimpleCommand(command: string): boolean {
	return !/[;&|\n\r`<>]|\$\(/.test(command.trim());
}

/**
 * Split a command into rough units on `&&`, `||`, `;`, `|` and newlines.
 *
 * Only used to validate and suggest patterns, never to allow anything: the
 * gate does the real parsing when it evaluates a policy rule per unit.
 */
export function commandUnits(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((unit) => unit.trim())
		.filter((unit) => unit.length > 0 && !unit.startsWith("#"));
}

/**
 * Subcommand depth per command prefix, longest match wins. Copied from the
 * gate's `bash-arity.ts`, plus a few git subcommands that take a verb of
 * their own (`git worktree remove`, `git stash drop`, …).
 */
export const ARITY: Record<string, number> = {
	git: 2,
	"git worktree": 3,
	"git stash": 3,
	"git remote": 3,
	"git submodule": 3,
	hg: 2,
	svn: 2,
	npm: 2,
	"npm run": 3,
	"npm exec": 3,
	npx: 2,
	pnpm: 2,
	"pnpm run": 3,
	"pnpm exec": 3,
	"pnpm dlx": 3,
	yarn: 2,
	"yarn run": 3,
	bun: 2,
	"bun run": 3,
	"bun add": 2,
	"bun x": 3,
	deno: 2,
	"deno run": 3,
	"deno task": 3,
	"deno compile": 3,
	pip: 2,
	pip3: 2,
	uv: 2,
	"uv run": 3,
	"uv pip": 3,
	cargo: 2,
	go: 2,
	"go run": 3,
	bundle: 2,
	"bundle exec": 3,
	docker: 2,
	"docker compose": 3,
	"docker container": 3,
	"docker image": 3,
	"docker network": 3,
	"docker volume": 3,
	podman: 2,
	"podman compose": 3,
	kubectl: 2,
	helm: 2,
	aws: 3,
	az: 3,
	gcloud: 3,
	gh: 2,
	"gh pr": 3,
	"gh issue": 3,
	"gh repo": 3,
	"gh run": 3,
	"gh release": 3,
	fly: 2,
	vercel: 2,
	wrangler: 2,
	make: 1,
	bazel: 2,
	terraform: 2,
	tofu: 2,
	pulumi: 2,
	systemctl: 2,
	service: 2,
	brew: 2,
	apt: 2,
	"apt-get": 2,
	yum: 2,
	dnf: 2,
};

/** The meaningful prefix tokens of a command, as the gate's `prefix()` computes them. */
export function commandPrefix(tokens: string[]): string[] {
	if (tokens.length === 0) return [];
	for (let n = tokens.length; n >= 1; n--) {
		const key = tokens
			.slice(0, n)
			.map((token) => token.toLowerCase())
			.join(" ");
		const arity = ARITY[key];
		if (arity !== undefined) return tokens.slice(0, Math.min(arity, tokens.length));
	}
	return tokens.slice(0, 1);
}

/**
 * Suggest the narrowest useful pattern for a bash command: its subcommand
 * prefix plus ` *`, e.g. `git worktree remove *`. Falls back to the exact
 * command when there are no arguments past the prefix.
 */
export function suggestBashPattern(command: string): string {
	const units = commandUnits(command);
	// `cd dir && real-command` is the common shape; the cd is never the refusal.
	const unit = units.find((item) => !/^cd(\s|$)/.test(item)) ?? units[0] ?? command.trim();
	const tokens = unit.split(/\s+/).filter(Boolean);
	const head = commandPrefix(tokens);
	if (tokens.length <= head.length) return units.length === 1 ? command.trim() : unit;
	return `${head.join(" ")} *`;
}

/**
 * Guardrail on the shape of a bash pattern: the first word must be literal,
 * so a rule can never cover every command (`*`, `g*`, `? *`). A `*` may only
 * end the pattern: an inner one spans arguments, so `git -C * push *` would
 * also cover `git -C . config core.pager <program> push`.
 */
export function checkBashShape(pattern: string): string | null {
	const trimmed = pattern.trim();
	const first = trimmed.split(/\s+/)[0] ?? "";
	if (!first) return "pattern is empty";
	if (hasWildcard(first)) return "the first word must be literal, not a wildcard";
	if (trimmed.slice(0, -1).includes("*")) return "`*` may only end a bash pattern, since it matches across arguments";
	return null;
}

/** Whether a bash pattern covers the command, or one of its units. */
export function coversCommand(pattern: string, command: string): boolean {
	if (pattern === command) return true;
	if (wildcardMatch(pattern, command)) return true;
	return commandUnits(command).some((unit) => wildcardMatch(pattern, unit));
}
