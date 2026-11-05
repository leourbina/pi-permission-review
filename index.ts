/**
 * Permission review for pi.
 *
 * Adds `/permissions`: a panel over the denial log written by
 * @gotgenes/pi-permission-system, with three ways to undo a refusal —
 * approve for this session, remember it, or write a real policy rule.
 *
 * The override mechanism is an authorizer chain link. A link can only lift an
 * `authorizer` denial; `policy` denials (and the path / external_directory
 * surfaces) are decided before any link runs, so those go through a rule write
 * followed by a reload.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
	SessionApprovals,
	writeApprovals,
} from "./approvals.ts";
import { type Denial, isLinkExcludedSurface, timeLabel } from "./denials.ts";
import { openPanel, type PanelResult } from "./panel.ts";
import {
	retryMessage,
	takePendingRetry,
	writePendingRetry,
	type PendingRetry,
	writeRule,
} from "./policy.ts";

const LINK_NAME = "review-approvals";
/** Bumped whenever the panel's rendering changes; logged on load to prove a reload took. */
const VERSION = "0.9.3";
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

		const pending = takePendingRetry(agentDir(), Date.now());
		if (pending) {
			setTimeout(() => {
				const command = ctx as unknown as ExtensionCommandContext;
				send(command, retryMessage(pending.toolName, pending.value));
			}, 400);
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
					"/permissions — review denials. Keys: a approve, r remember, w write rule, d delete, e edit, ctrl+o expand, tab switch.",
					"info",
				);
				return;
			}

			const denials: Denial[] = feed;
			const approvals: Approvals = readApprovals(paths().approvals);

			const result: PanelResult = await openPanel(ctx, {
				denials,
				// Remembered tab: durable entries only. Session-scoped approvals live
				// in their own tab, sourced from the in-memory set.
				approvals: {
					exact: approvals.exact.filter((entry) => entry.scope !== "session"),
					patterns: approvals.patterns.filter((entry) => entry.scope !== "session"),
				},
				session,
				judge: judgeLabel(),
			});
			if (!result) return;

			if (result.kind === "approve") {
				const { denial, remember } = result;
				session.add(denial.surface, denial.value);
				let next = addEntry(
					approvals,
					"exact",
					denial.surface,
					denial.value,
					remember ? { scope: "always" } : { scope: "session", sessionId: sessionId ?? "" },
				);
				// A remembered decision should also cover the pattern the gate matched,
				// when that pattern is narrower than the whole tool.
				const suggested = denial.matchedPattern;
				if (suggested && suggested !== "*" && suggested !== denial.value) {
					next = addEntry(
						next,
						"pattern",
						denial.surface,
						suggested,
						remember ? { scope: "always" } : { scope: "session", sessionId: sessionId ?? "" },
					);
				}
				writeApprovals(paths().approvals, next);
				dropFromFeed(denial);
				audit({
					event: "permissions-review.approved",
					scope: remember ? "remembered" : "session",
					surface: denial.surface,
					value: denial.value,
					rule: denial.matchedPattern,
					requestId: denial.requestId,
				});
				ctx.ui.notify(
					`${remember ? "Remembered" : "Approved"} · retrying ${denial.value.slice(0, 60)}`,
					"info",
				);
				send(ctx, retryMessage(denial.toolName, denial.value));
				return;
			}

			if (result.kind === "delete") {
				const next = deleteEntry(approvals, result.listKind, result.entry.surface, result.entry.value);
				writeApprovals(paths().approvals, next);
				ctx.ui.notify(`Removed approval ${result.entry.value.slice(0, 60)}`, "info");
				return;
			}

			// write-rule: a policy denial the link cannot lift.
			const written = writeRule(paths().policyConfig, result.denial, result.pattern);
			if (!written.ok) {
				ctx.ui.notify(`Could not write rule: ${written.error}`, "error");
				return;
			}
			const retry: PendingRetry = {
				value: result.denial.value,
				toolName: result.denial.toolName,
				surface: result.denial.surface,
				at: Date.now(),
			};
			writePendingRetry(agentDir(), retry);
			// Persisted before the reload, so the panel does not re-list a request
			// whose rule has just been written.
			dropFromFeed(result.denial);
			audit({
				event: "permissions-review.rule-written",
				surface: result.denial.surface,
				key: written.key,
				pattern: written.pattern,
				requestId: result.denial.requestId,
			});
			ctx.ui.notify(
				`Rule written (${written.key}: ${written.pattern}) · reloading, then retrying`,
				"info",
			);
			await ctx.reload();
		},
	});
}
