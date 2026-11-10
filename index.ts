/**
 * Permission review for pi.
 *
 * Adds `/permissions`: a panel over the denial log written by
 * @gotgenes/pi-permission-system, with three ways to undo a refusal —
 * approve for this session, remember it, or write a real policy rule.
 *
 * The override mechanism is an authorizer chain link. A link can only lift an
 * `authorizer` denial; `policy` denials (and the path / external_directory
 * surfaces) are decided before any link runs, so those go through a rule
 * write. The gate re-reads its config on the next call, so no reload is needed.
 */

import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	addEntry,
	deleteEntry,
	matches as storeMatches,
	pruneOtherSessions,
	sessionEntries,
	type Approvals,
	readApprovals,
	replaceEntry,
	SessionApprovals,
	writeApprovals,
} from "./approvals.ts";
import { type Denial, isLinkExcludedSurface } from "./denials.ts";
import { openPanel, type PanelResult } from "./panel.ts";
import { retryAllMessage } from "./marks.ts";
import { ruleConflicts, writeRule } from "./policy.ts";

const LINK_NAME = "review-approvals";

/** The package version, logged on load to prove a reload took. */
const VERSION = (() => {
	try {
		const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
})();
const SERVICES_SYMBOL = Symbol.for("@gotgenes/pi-permission-system:session-services");

type SessionServices = Map<string, { registerAuthorizer(name: string, authorize: unknown): () => void }>;

function agentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

function paths() {
	const dir = agentDir();
	// State lives outside the extension directory: under npm that directory is
	// node_modules, which an update replaces.
	const state = join(dir, "permission-review");
	return {
		dir,
		state,
		approvals: join(state, "approvals.json"),
		denials: join(state, "denials.json"),
		reviewLog: join(
			dir,
			"extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl",
		),
		policyConfig: join(dir, "extensions/pi-permission-system/config.json"),
		classifierConfig: join(dir, "extensions/pi-permission-classifier/config.json"),
		/** Where a hand-placed copy kept its state before 0.8.0. */
		legacyState: join(dir, "extensions/permission-review"),
	};
}

/** What every `permissions:decision` broadcast carries, structurally. */
type DecisionBroadcast = {
	requestId?: string;
	surface?: string;
	value?: string;
	result?: "allow" | "deny";
	resolution?: string;
	matchedPattern?: string | null;
	agentName?: string | null;
};

/** How many denials the feed keeps. */
const FEED_LIMIT = 50;

/** Plain-language reason for a decision `resolution` value. */
function describeDenial(resolution: string): string {
	switch (resolution) {
		case "authorizer_denied":
			return "denied by the review judge";
		case "policy_deny":
			return "denied by a policy rule";
		case "user_denied":
			return "denied in the permission dialog";
		case "confirmation_unavailable":
			return "requires approval, but no UI was available";
		case "prompt_unanswered":
			return "the permission prompt timed out";
		case "gate_error":
			return "the permission gate errored (fail-closed)";
		default:
			return resolution || "denied";
	}
}

type FeedFile = { sessionId: string; entries: Denial[] };

function readFeed(path: string, sessionId: string): Denial[] {
	for (const candidate of [path, path.replace(/\/permission-review\//, "/extensions/permission-review/")]) {
		try {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as FeedFile;
			if (parsed.sessionId === sessionId && Array.isArray(parsed.entries)) return parsed.entries;
		} catch {
			// try the next location
		}
	}
	return [];
}

function writeFeed(path: string, sessionId: string, entries: Denial[]): void {
	try {
		writeFileSync(path, `${JSON.stringify({ sessionId, entries: entries.slice(0, FEED_LIMIT) }, null, 2)}\n`, "utf8");
	} catch {
		// the feed is a convenience, never a failure source
	}
}

/** Human label for the reviewer currently gating bash calls. */
function judgeLabel(): string {
	try {
		const config = JSON.parse(readFileSync(paths().classifierConfig, "utf8")) as Record<string, unknown>;
		const quick = (config.quickJudge ?? {}) as Record<string, unknown>;
		const mode = typeof config.mode === "string" ? config.mode : "llm";
		const model =
			(mode === "quick" && typeof quick.model === "string" ? quick.model : undefined) ??
			(typeof config.model === "string" ? config.model : undefined);
		return model ? `judge ${model}` : `judge ${mode}`;
	} catch {
		return "";
	}
}

/** One audit line per approval, alongside the gate's own decision trail. */
function audit(entry: Record<string, unknown>): void {
	try {
		appendFileSync(
			paths().reviewLog,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				extension: "permission-review",
				stream: "review",
				...entry,
			})}\n`,
			"utf8",
		);
	} catch {
		// auditing must never block the approval
	}
}

function requestOf(details: unknown): { surface: string; value: string; toolName: string | null } {
	const payload = (details as { payload?: { request?: Record<string, unknown> } }).payload?.request ?? {};
	const wrapper = details as { surface?: string | null; value?: string | null };
	const surface =
		(typeof wrapper.surface === "string" && wrapper.surface) ||
		(typeof payload["surface"] === "string" && (payload["surface"] as string)) ||
		"unknown";
	const value =
		(typeof wrapper.value === "string" && wrapper.value) ||
		(typeof payload["value"] === "string" && (payload["value"] as string)) ||
		"";
	const toolName = typeof payload["toolName"] === "string" ? (payload["toolName"] as string) : null;
	return { surface, value, toolName };
}

export default function permissionReview(pi: ExtensionAPI): void {
	const session = new SessionApprovals();
	let sessionId: string | undefined;
	/** Denials observed in this session, newest first. */
	let feed: Denial[] = [];
	let dispose: (() => void) | undefined;
	let registered = false;

	const send = (ctx: ExtensionCommandContext, text: string): void => {
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(text, { expandPromptTemplates: false });
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
			}
		} catch {
			// A closed session must not throw out of a command handler.
		}
	};

	/**
	 * Drop a denial from the feed once the user has acted on it: the list is a
	 * queue of outstanding refusals, not a log. Keyed the same way the feed
	 * dedupes, so a re-denial of the same call simply reappears as a new row.
	 */
	const dropFromFeed = (denial: Denial): void => {
		feed = feed.filter((item) => !(item.surface === denial.surface && item.value === denial.value));
		if (sessionId) writeFeed(paths().denials, sessionId, feed);
	};

	const resolveService = (sessionId: string) => {
		const services = (globalThis as Record<symbol, unknown>)[SERVICES_SYMBOL] as SessionServices | undefined;
		return services?.get(sessionId);
	};

	const registerLink = (sessionId: string): void => {
		if (registered) return;
		const service = resolveService(sessionId);
		if (!service) return;
		try {
			dispose = service.registerAuthorizer(LINK_NAME, async (details: unknown) => {
				const { surface, value } = requestOf(details);
				if (!value || isLinkExcludedSurface(surface)) return { kind: "defer" };

				if (session.has(surface, value)) {
					audit({ event: "permissions-review.allowed", via: "link", scope: "session", surface, value });
					return { kind: "allow" };
				}
				const approvals = readApprovals(paths().approvals);
				if (storeMatches(approvals, surface, value, sessionId)) {
					audit({ event: "permissions-review.allowed", via: "link", scope: "remembered", surface, value });
					return { kind: "allow" };
				}
				return { kind: "defer" };
			});
			registered = true;
		} catch {
			registered = false;
		}
	};

	pi.on("session_start", (event, ctx) => {
		// A reload re-runs this handler in a fresh module instance, but the user's
		// session (and their approvals) did not end. Only a real session start
		// resets the review window.
		const isReload = event.reason === "reload";
		if (!isReload) session.clear();
		audit({ event: "permissions-review.loaded", version: VERSION, reason: event.reason });

		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}

		// Denials are collected from this session's own decision broadcasts, so a
		// reload keeps what it already saw rather than starting empty.
		feed = isReload && sessionId ? readFeed(paths().denials, sessionId) : [];

		// A reload loses in-memory state, so re-hydrate this session's approvals
		// from the store and drop entries belonging to sessions that are gone.
		if (sessionId) {
			try {
				const pruned = pruneOtherSessions(readApprovals(paths().approvals), sessionId);
				writeApprovals(paths().approvals, pruned);
				for (const entry of sessionEntries(pruned, sessionId)) {
					session.add(entry.surface, entry.value);
				}
			} catch {
				// a broken store must never block startup
			}
		}

		// Register immediately when the service is already published for this
		// session; `permissions:ready` repeats at the first agent turn if not.
		try {
			registerLink(ctx.sessionManager.getSessionId());
		} catch {
			// session manager unavailable in this host
		}

		// Versions before 1.1 parked a retry here across a reload; rules now apply
		// without one, so a leftover file is only noise.
		try {
			rmSync(join(paths().state, "pending-retry.json"), { force: true });
		} catch {
			// nothing to clean
		}
	});
	pi.on("session_shutdown", () => {
		session.clear();
		try {
			dispose?.();
		} catch {
			// nothing to release
		}
		dispose = undefined;
		registered = false;
	});

	pi.events.on("permissions:ready", (data: unknown) => {
		const sessionId = (data as { sessionId?: string }).sessionId;
		if (sessionId) registerLink(sessionId);
	});

	// The review log is shared by every pi session on this machine and carries no
	// session id on denial entries, so it cannot tell whose refusals these are.
	// The decision broadcast is per-session by construction.
	pi.events.on("permissions:decision", (raw: unknown) => {
		const event = raw as DecisionBroadcast;
		if (event.result !== "deny" || !event.value) return;

		const resolution = event.resolution ?? "";
		const fromAuthorizer = resolution.startsWith("authorizer");
		const denial: Denial = {
			requestId: event.requestId ?? "",
			ts: Date.now(),
			surface: event.surface ?? "unknown",
			toolName: event.surface ?? null,
			value: event.value,
			matchedPattern: event.matchedPattern ?? null,
			decidedByKind: fromAuthorizer ? "authorizer" : "policy",
			decidedByName: fromAuthorizer ? "permission-judge" : resolution,
			reason: describeDenial(resolution),
			// Only a chain link's refusal can be lifted by one.
			overridable: resolution === "authorizer_denied",
		};
		feed = [denial, ...feed.filter((item) => !(item.surface === denial.surface && item.value === denial.value))].slice(
			0,
			FEED_LIMIT,
		);
		if (sessionId) writeFeed(paths().denials, sessionId, feed);
	});

	pi.registerCommand("permissions", {
		description: "Review recently denied tool calls, allow and retry them",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/permissions requires interactive TUI mode", "error");
				return;
			}
			if (args.trim() === "help") {
				ctx.ui.notify(
					"/permissions — review denials. Keys: enter mark approve, r mark retry, esc apply marks, m remember, w write rule, d delete, e edit, ctrl+o expand, tab switch.",
					"info",
				);
				return;
			}

			const denials: Denial[] = feed;
			const approvals: Approvals = readApprovals(paths().approvals);

			const result: PanelResult | undefined = await openPanel(ctx, {
				denials,
				// Remembered tab: durable entries only. Session-scoped approvals live
				// in their own tab, sourced from the in-memory set.
				approvals: {
					exact: approvals.exact.filter((entry) => entry.scope !== "session"),
					patterns: approvals.patterns.filter((entry) => entry.scope !== "session"),
				},
				session,
				midTurn: !ctx.isIdle(),
				judge: judgeLabel(),
				ruleConflicts: (denial, pattern) => ruleConflicts(paths().policyConfig, denial, pattern),
			});
			if (!result) return;

			let store = approvals;
			const retry: Denial[] = [...result.retry];

			// Every marked row is approved for this session; retry is a subset.
			for (const denial of result.approved) {
				session.add(denial.surface, denial.value);
				store = addEntry(store, "exact", denial.surface, denial.value, { scope: "session", sessionId: sessionId ?? "" });
				dropFromFeed(denial);
				audit({
					event: "permissions-review.approved",
					scope: "session",
					surface: denial.surface,
					value: denial.value,
					requestId: denial.requestId,
					retry: result.retry.includes(denial),
				});
			}

			const action = result.action;
			if (action?.kind === "remember") {
				const { denial, pattern } = action;
				const kind = pattern === denial.value ? "exact" : "pattern";
				store = addEntry(store, kind, denial.surface, pattern, { scope: "always" });
				dropFromFeed(denial);
				audit({
					event: "permissions-review.approved",
					scope: "remembered",
					surface: denial.surface,
					value: denial.value,
					pattern,
					requestId: denial.requestId,
				});
				ctx.ui.notify(`Remembered ${pattern.slice(0, 60)}`, "info");
				if (!action.fromSession) retry.push(denial);
			} else if (action?.kind === "delete") {
				store = deleteEntry(store, action.listKind, action.entry.surface, action.entry.value);
				ctx.ui.notify(`Removed approval ${action.entry.value.slice(0, 60)}`, "info");
			} else if (action?.kind === "edit") {
				store = replaceEntry(store, action.listKind, action.entry, action.pattern);
				audit({
					event: "permissions-review.edited",
					surface: action.entry.surface,
					from: action.entry.value,
					to: action.pattern,
				});
				ctx.ui.notify(`Updated ${action.entry.value.slice(0, 40)} → ${action.pattern.slice(0, 40)}`, "info");
			} else if (action?.kind === "write-rule") {
				// Takes effect on the next gate call, no reload needed.
				const written = writeRule(paths().policyConfig, action.denial, action.pattern);
				if (written.ok) {
					dropFromFeed(action.denial);
					audit({
						event: "permissions-review.rule-written",
						surface: action.denial.surface,
						key: written.key,
						pattern: written.pattern,
						requestId: action.denial.requestId,
					});
					ctx.ui.notify(`Rule written (${written.key}: ${written.pattern})`, "info");
					if (!action.fromSession) retry.push(action.denial);
				} else {
					ctx.ui.notify(`Could not write rule: ${written.error}`, "error");
				}
			}

			if (store !== approvals) writeApprovals(paths().approvals, store);

			const unique = retry.filter(
				(denial, index) =>
					retry.findIndex((other) => other.surface === denial.surface && other.value === denial.value) === index,
			);
			const approvedOnly = result.approved.length - result.retry.length;
			if (approvedOnly > 0) {
				ctx.ui.notify(`Approved ${approvedOnly} blocked ${approvedOnly === 1 ? "call" : "calls"} for this session`, "info");
			}
			if (unique.length > 0) {
				ctx.ui.notify(`Retrying ${unique.length} ${unique.length === 1 ? "call" : "calls"}`, "info");
				send(ctx, retryAllMessage(unique));
			}
		},
	});
}
