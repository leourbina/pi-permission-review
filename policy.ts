/**
 * Policy writes: a real allow rule in pi-permission-system's config.
 *
 * This is the only way to undo a `policy` denial, since those are decided
 * before any chain link runs, and pi-permission-system refuses to let a link
 * allow the `path` and `external_directory` surfaces at all. For bash it is
 * also the better tool: the gate evaluates a rule per command unit, so
 * `git worktree remove *` covers `cd x && git worktree remove y`, which a
 * remembered approval (matched against the whole string) cannot.
 *
 * The gate re-reads its config whenever the file's mtime changes, so a rule
 * takes effect on the next call — no reload needed.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Denial } from "./denials.ts";
import { checkBashShape, coversCommand, hasWildcard, suggestBashPattern, wildcardMatch } from "./pattern.ts";

export type RuleResult =
	| { ok: true; key: string; pattern: string }
	| { ok: false; error: string };

export type PolicyKey = "bash" | "path" | "external_directory" | "skill" | "mcp";

/** The policy key a denial's surface writes into. */
export function policyKeyForSurface(surface: string): PolicyKey {
	if (surface === "bash") return "bash";
	if (surface === "path" || surface.startsWith("path_")) return "path";
	if (surface === "external_directory" || surface.startsWith("external_directory_")) {
		return "external_directory";
	}
	if (surface === "skill" || surface.startsWith("skill_")) return "skill";
	return "mcp";
}

type Checked = { ok: true; pattern: string } | { ok: false; error: string };

/**
 * Whether a pattern is acceptable on its own, with no denial to compare
 * against. Used when editing a remembered approval.
 *  - bash: the first word is literal (no `*`, `g*`, `? *`)
 *  - filesystem surfaces: an exact path, never a glob
 *  - mcp/skill: not a bare wildcard, and starts with a literal character
 */
export function checkPatternShape(surface: string, candidate: string): Checked {
	const pattern = candidate.trim();
	if (!pattern) return { ok: false, error: "pattern is empty" };
	const key = policyKeyForSurface(surface);
	if (key === "bash") {
		const error = checkBashShape(pattern);
		return error ? { ok: false, error } : { ok: true, pattern };
	}
	if (key === "path" || key === "external_directory") {
		if (hasWildcard(pattern)) return { ok: false, error: "path rules must name the exact path, not a pattern" };
		return { ok: true, pattern };
	}
	if (hasWildcard(pattern.charAt(0))) return { ok: false, error: "the pattern must start with a literal name" };
	return { ok: true, pattern };
}

/**
 * The patterns this extension will write for a denial: a valid shape (see
 * {@link checkPatternShape}) that also covers the refused call.
 *  - bash: the exact command, or any literal-first-word pattern that matches
 *    it or one of its units — `git worktree remove *`, `gh pr view * --json *`
 *  - filesystem surfaces: the exact path
 *  - mcp/skill: the exact name, or a pattern that matches it
 */
export function sanitisePattern(denial: Denial, candidate: string): Checked {
	const shaped = checkPatternShape(denial.surface, candidate);
	if (!shaped.ok) return shaped;
	const { pattern } = shaped;

	const key = policyKeyForSurface(denial.surface);
	if (key === "path" || key === "external_directory") {
		return pattern === denial.value
			? { ok: true, pattern }
			: { ok: false, error: "path rules must name the exact path, not a pattern" };
	}
	if (key === "bash") {
		return coversCommand(pattern, denial.value)
			? { ok: true, pattern }
			: { ok: false, error: "the pattern does not match this command" };
	}
	return pattern === denial.value || wildcardMatch(pattern, denial.value)
		? { ok: true, pattern }
		: { ok: false, error: "the pattern does not match this call" };
}

/** Suggest the narrowest useful pattern for a denial. */
export function suggestPattern(denial: Denial): string {
	return policyKeyForSurface(denial.surface) === "bash" ? suggestBashPattern(denial.value) : denial.value;
}

/** Remove `//` and `/* *\/` comments outside strings, as the gate's loader does. */
export function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const next = text[i + 1];
		if (inString) {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
		} else if (char === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else {
			out += char;
		}
	}
	return out;
}

type Loaded = { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

/**
 * Read the policy config. A config with comments is readable by the gate but
 * would lose them on a rewrite, so it is refused rather than silently stripped.
 */
export function readPolicy(configPath: string): Loaded {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		return { ok: false, error: `cannot read policy config: ${(error as Error).message}` };
	}
	try {
		return { ok: true, config: JSON.parse(raw) as Record<string, unknown> };
	} catch {
		try {
			JSON.parse(stripJsonComments(raw));
		} catch (error) {
			return { ok: false, error: `policy config is not valid JSON: ${(error as Error).message}` };
		}
		return { ok: false, error: "policy config has comments, which a rewrite would drop — add the rule by hand" };
	}
}

function sectionOf(config: Record<string, unknown>, key: PolicyKey): Record<string, unknown> {
	const permission = (config.permission ?? {}) as Record<string, unknown>;
	const section = permission[key];
	return typeof section === "object" && section !== null ? (section as Record<string, unknown>) : {};
}

/**
 * Reasons to pause before writing an allow rule. The gate's last matching rule
 * wins and a new rule is written last, so an allow that overlaps a `deny`
 * silently lifts it for the commands they share.
 */
export function ruleConflicts(configPath: string, denial: Denial, pattern: string): string[] {
	const loaded = readPolicy(configPath);
	if (!loaded.ok) return [];
	const key = policyKeyForSurface(denial.surface);
	const warnings: string[] = [];
	for (const [existing, state] of Object.entries(sectionOf(loaded.config, key))) {
		if (state !== "deny") continue;
		if (existing === pattern) {
			warnings.push(`replaces the deny rule "${existing}"`);
		} else if (wildcardMatch(existing, pattern) || wildcardMatch(pattern, existing)) {
			warnings.push(`overrides the deny rule "${existing}" where they overlap`);
		}
	}
	if (key === "bash" && pattern === denial.value && hasWildcard(pattern)) {
		warnings.push("the command contains * or ?, which the gate reads as wildcards");
	}
	return warnings;
}

/**
 * Add an allow rule and return the key that now holds it. The rule is moved to
 * the end of its section so it wins (the gate takes the last match), the
 * previous config is kept in `config.json.bak`, and only valid JSON is written.
 */
export function writeRule(configPath: string, denial: Denial, pattern: string): RuleResult {
	const checked = sanitisePattern(denial, pattern);
	if (!checked.ok) return { ok: false, error: checked.error };

	const loaded = readPolicy(configPath);
	if (!loaded.ok) return loaded;
	const { config } = loaded;

	const permission = (config.permission ?? {}) as Record<string, unknown>;
	const key = policyKeyForSurface(denial.surface);
	const section = { ...sectionOf(config, key) };
	delete section[checked.pattern];
	section[checked.pattern] = "allow";
	permission[key] = section;
	config.permission = permission;

	try {
		copyFileSync(configPath, `${configPath}.bak`);
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

/** The exact retry sentence sent to the model. */
export function retryMessage(toolName: string | null, value: string): string {
	const call = toolName ? `${toolName} ${value}` : value;
	return `Retry the call you just attempted: ${call}`;
}
