/**
 * The /permissions overlay.
 *
 * Three tabs over the same panel: what was denied, what has been remembered,
 * and what is approved for this session only. It deliberately borrows the gate
 * dialog's visual language (label : value facts, ▶ selection marker, (key)
 * actions) so the two screens read as one system.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	type ApprovalEntry,
	type ApprovalKind,
	type Approvals,
	countMatches,
	SessionApprovals,
	entryMatches,
} from "./approvals.ts";
import { type Denial, isLinkExcludedSurface, timeLabel } from "./denials.ts";
import { policyKeyForSurface, sanitisePattern, suggestPattern } from "./policy.ts";

export type PanelResult =
	| { kind: "approve"; denial: Denial; remember: boolean }
	| { kind: "write-rule"; denial: Denial; pattern: string }
	| { kind: "delete"; entry: ApprovalEntry; listKind: ApprovalKind }
	| undefined;

export type PanelData = {
	denials: Denial[];
	approvals: Approvals;
	session: SessionApprovals;
	/** Short description of the active reviewer, shown top-right. */
	judge: string;
};

type Tab = "denied" | "remembered" | "session";

/** A rendered list line; `highlight` paints it with the selection background. */
type PanelRow = { text: string; highlight?: boolean };

type RememberedRow = { entry: ApprovalEntry; listKind: ApprovalKind };

const TABS: Tab[] = ["denied", "remembered", "session"];
const NARROW = 72;
/** Interior horizontal padding, in columns, on each side of the content. */
const PAD = 2;
/** List rows shown at once; longer lists scroll around the cursor. */
const MAX_ROWS = 8;
/** Theme role used to fill the panel background (see themes: toolPendingBg). */
const PANEL_BG = "toolPendingBg";

const GLYPH = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeLeft: "├",
	teeRight: "┤",
	marker: "▶",
	active: "⟦",
	activeEnd: "⟧",
	cursor: "▏",
};

function plainTruncate(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	return truncateToWidth(text, width);
}

/** Pad to an exact display width, ignoring ANSI escapes and wide glyphs. */
function padTo(text: string, target: number): string {
	return text + " ".repeat(Math.max(0, target - visibleWidth(text)));
}

export async function openPanel(
	ctx: ExtensionCommandContext,
	data: PanelData,
): Promise<PanelResult> {
	return ctx.ui.custom<PanelResult>(
		(tui, theme, keybindings, done) => {
			let tab: Tab = "denied";
			let cursor = 0;
			let expanded = false;
			let editing = false;
			let editorValue = "";
			let hint = "";
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			const fg = (token: string, text: string): string => {
				try {
					return theme.fg(token as never, text);
				} catch {
					return text;
				}
			};

			/**
			 * Paint a whole rendered line with a panel background.
			 *
			 * `theme.bg` wraps the string, but any full SGR reset *inside* it — a
			 * truncation, or a helper that ends with `ESC[0m` — cancels the background
			 * for the rest of the line, which showed up as the fill stopping where the
			 * text stopped. Re-opening the background after every reset keeps the
			 * padding and the trailing timestamp painted too.
			 */
			const bgFill = (line: string, token: string = PANEL_BG): string => {
				try {
					const wrapped = theme.bg(token as never, "\u0000");
					const split = wrapped.indexOf("\u0000");
					const open = split >= 0 ? wrapped.slice(0, split) : wrapped;
					const painted = line.replace(/\x1b\[(?:0|49)m/g, (reset) => `${reset}${open}`);
					return `${open}${painted}\x1b[49m`;
				} catch {
					return line;
				}
			};

			const invalidate = (): void => {
				cachedWidth = undefined;
				cachedLines = undefined;
			};

			const remembered = (): RememberedRow[] => [
				...data.approvals.patterns.map((entry) => ({ entry, listKind: "pattern" as const })),
				...data.approvals.exact.map((entry) => ({ entry, listKind: "exact" as const })),
			];

			const sessionRows = () => data.session.values();

			const rowCount = (): number => {
				if (tab === "denied") return data.denials.length;
				if (tab === "remembered") return remembered().length;
				return sessionRows().length;
			};

			const selectedDenial = (): Denial | undefined =>
				tab === "denied" ? data.denials[cursor] : undefined;
			const selectedRemembered = (): RememberedRow | undefined =>
				tab === "remembered" ? remembered()[cursor] : undefined;

			const denyUnavailable = (why: string): void => {
				hint = why;
				invalidate();
				tui.requestRender();
			};

			const approve = (remember: boolean): void => {
				const denial = selectedDenial();
				if (!denial) return;
				if (!denial.overridable) {
					denyUnavailable("an authorizer cannot lift a rule — write one instead (w)");
					return;
				}
				done({ kind: "approve", denial, remember });
			};

			const startRule = (): void => {
				const denial = selectedDenial();
				if (!denial) return;
				editing = true;
				editorValue = suggestPattern(denial);
				hint = "";
				invalidate();
				tui.requestRender();
			};

			const commitRule = (): void => {
				const denial = selectedDenial();
				if (!denial) {
					editing = false;
					return;
				}
				const checked = sanitisePattern(denial, editorValue);
				if (!checked.ok) {
					denyUnavailable(checked.error);
					return;
				}
				done({ kind: "write-rule", denial, pattern: checked.pattern });
			};

			const removeRemembered = (): void => {
				const row = selectedRemembered();
				if (!row) return;
				done({ kind: "delete", entry: row.entry, listKind: row.listKind });
			};

			const editRemembered = (): void => {
				const row = selectedRemembered();
				if (!row) return;
				// Editing a stored pattern is a delete + write; hand the value back
				// as a pre-filled rule editor over the denial that produced it.
				const denial = data.denials.find(
					(item) => item.surface === row.entry.surface && entryMatches(row.entry, item.surface, item.value),
				);
				if (!denial) {
					denyUnavailable("no recent denial matches this pattern — delete it instead (d)");
					return;
				}
				tab = "denied";
				cursor = Math.max(0, data.denials.indexOf(denial));
				editing = true;
				editorValue = row.entry.value;
				hint = "";
				invalidate();
				tui.requestRender();
			};

			const cycleTab = (delta: number): void => {
				const index = TABS.indexOf(tab);
				tab = TABS[(index + delta + TABS.length) % TABS.length] ?? "denied";
				cursor = 0;
				hint = "";
				invalidate();
				tui.requestRender();
			};

			const move = (delta: number): void => {
				const count = rowCount();
				if (count === 0) return;
				cursor = (cursor + delta + count) % count;
				hint = "";
				invalidate();
				tui.requestRender();
			};

			// ---- rendering -------------------------------------------------

			/** Interior content width for a given panel width. */
			const contentWidth = (width: number): number => Math.max(8, width - 4 - PAD * 2);

			/**
			 * One content row: left border, background-filled interior, right border.
			 * Every body line must go through this — a bare content string has no
			 * frame and renders as an unbordered band.
			 */
			const row = (width: number, text: string, highlight = false): string => {
				const inner = contentWidth(width);
				const gutter = " ".repeat(PAD + 1);
				const fill = gutter + padTo(plainTruncate(text, inner), inner) + gutter;
				// Fill the whole line, borders included: the background then starts at
				// the left edge of the box and stops exactly after the right border
				// instead of leaving a gap or trailing past it.
				return truncateToWidth(
					bgFill(
						`${fg("border", GLYPH.vertical)}${fill}${fg("border", GLYPH.vertical)}`,
						highlight ? "selectedBg" : PANEL_BG,
					),
					width,
				);
			};

			/** A full-width rule, optionally labelled, filled edge to edge. */
			const separator = (width: number, label: string): string => {
				const text = label ? ` ${label} ` : "";
				const fill = Math.max(0, width - 3 - text.length);
				const body = GLYPH.horizontal + text + GLYPH.horizontal.repeat(fill);
				return truncateToWidth(
					bgFill(`${fg("border", GLYPH.teeLeft)}${body}${fg("border", GLYPH.teeRight)}`),
					width,
				);
			};

			const edge = (width: number, left: string, right: string): string =>
				truncateToWidth(
					bgFill(`${fg("border", left)}${GLYPH.horizontal.repeat(Math.max(0, width - 2))}${fg("border", right)}`),
					width,
				);

			/** Assemble the frame. Body lines are already width-exact. */
			const frame = (width: number, body: string[]): string[] => [
				edge(width, GLYPH.topLeft, GLYPH.topRight),
				...(body.length ? body : [row(width, "")]),
				edge(width, GLYPH.bottomLeft, GLYPH.bottomRight),
			];

			const tabBar = (): string => {
				const parts = TABS.map((name) => {
					const count =
						name === "denied" ? data.denials.length : name === "remembered" ? remembered().length : sessionRows().length;
					const label = `${name} ${count}`;
					return name === tab
						? fg("accent", `${GLYPH.active}${label}${GLYPH.activeEnd}`)
						: fg("dim", label);
				});
				const left = parts.join("   ");
				const right = fg("dim", data.judge);
				return `${left}   ${right}`;
			};

			/** A list row: its text and whether it is the current selection. */
			const listRow = (width: number, lead: string, tail: string, selected: boolean): PanelRow => {
				const inner = contentWidth(width);
				const tailWidth = visibleWidth(tail);
				const avail = Math.max(8, inner - tailWidth - 1);
				const clipped = plainTruncate(lead, avail);
				return {
					text: tail ? `${padTo(clipped, inner - tailWidth)}${tail}` : clipped,
					highlight: selected,
				};
			};

			const denialRows = (width: number): PanelRow[] => {
				if (data.denials.length === 0) {
					return [
						{ text: "No denials in this session." },
						{ text: "A refusal lands here when the policy or the judge blocks a call." },
						{ text: "" },
					];
				}
				return data.denials.map((denial, index) => {
					const selected = index === cursor;
					const marker = selected ? GLYPH.marker : " ";
					const badge = denial.overridable ? "" : fg("warning", "!");
					const value = denial.value.replaceAll("\n", " ⏎ ");
					return listRow(width, `${marker} ${value}${badge}`, fg("dim", timeLabel(denial.ts)), selected);
				});
			};

			const rememberedRows = (width: number): PanelRow[] => {
				const rows = remembered();
				if (rows.length === 0) {
					return [
						{ text: "Nothing remembered yet." },
						{ text: "Approve with (r) to keep a decision across sessions." },
						{ text: "" },
					];
				}
				return rows.map((entry, index) => {
					const selected = index === cursor;
					const marker = selected ? GLYPH.marker : " ";
					const kind = entry.listKind === "pattern" ? "pattern" : "exact  ";
					const lead = `${marker} ${fg("dim", kind)} ${entry.entry.value}`;
					return listRow(width, lead, fg("dim", entry.entry.createdAt.slice(11, 16)), selected);
				});
			};

			const sessionRowsRendered = (width: number): PanelRow[] => {
				const rows = sessionRows();
				if (rows.length === 0) {
					return [
						{ text: "Nothing approved for this session." },
						{ text: "Session approvals die with the session." },
						{ text: "" },
					];
				}
				return rows.map((entry, index) => {
					const selected = index === cursor;
					const marker = selected ? GLYPH.marker : " ";
					return listRow(width, `${marker} ${fg("dim", entry.surface)} ${entry.value}`, "", selected);
				});
			};

			const facts = (narrow: boolean, width: number): PanelRow[] => {
				const inner = contentWidth(width);
				const label = (name: string): string => fg("dim", `${name.padEnd(9)}: `);

				if (tab !== "denied") {
					const entry = selectedRemembered();
					if (!entry) return [];
					const values = data.denials.map((denial) => denial.value);
					const matches = countMatches(entry.entry, values);
					if (narrow) {
						return [
							{ text: `${fg("dim", entry.entry.surface)} · ${entry.listKind}` },
							{ text: fg("dim", `${matches} recent denials match`) },
						];
					}
					return [
						{ text: `${label("surface")}${entry.entry.surface}` },
						{ text: `${label(entry.listKind === "pattern" ? "pattern" : "value")}${fg("accent", plainTruncate(entry.entry.value, inner - 11))}` },
						{ text: `${label("matches")}${matches} recent denials` },
						{ text: `${label("source")}approvals.json` },
					];
				}

				const denial = selectedDenial();
				if (!denial) return [];
				const decided = `${denial.decidedByKind}${denial.decidedByName ? ` · ${denial.decidedByName}` : ""}`;
				const verdict = denial.overridable ? "overridable" : fg("warning", "not overridable");
				if (narrow) {
					return [
						{ text: `${denial.surface} · ${verdict}` },
						{ text: plainTruncate(denial.reason, inner - 2) },
					];
				}
				const room = Math.max(16, inner - 11);
				// The list row truncates; the detail pane wraps, so a long command stays
				// readable here instead of ending in an ellipsis.
				const commandLines = wrapTextWithAnsi(denial.value, room);
				const shown = commandLines.slice(0, expanded ? 24 : 4);
				const commandFacts: PanelRow[] = shown.map((line, index) => ({
					text:
						index === 0
							? `${label("command")}${fg("accent", line)}`
							: `${" ".repeat(11)}${fg("accent", line)}`,
				}));
				if (commandLines.length > shown.length) {
					commandFacts.push({ text: fg("dim", `${" ".repeat(11)}… ctrl+o for the rest`) });
				}
				return [
					{ text: `${label("tool")}${denial.toolName ?? denial.surface}` },
					{ text: `${label("surface")}${denial.surface}` },
					{ text: `${label("rule")}${denial.matchedPattern ?? "-"}` },
					...commandFacts,
					{ text: `${label("why")}${fg("warning", plainTruncate(denial.reason, room))}` },
					{ text: `${label("decided")}${decided} · ${verdict}` },
					{ text: fg("dim", `${label("at")}${new Date(denial.ts || Date.now()).toISOString().slice(11, 19)} · ${denial.requestId || "-"}`) },
					...(denial.overridable
						? []
						: [{ text: fg("dim", "hint     : an authorizer cannot lift a rule — write one instead (w)") }]),
				];
			};

			const actions = (): string[] => {
				if (editing) {
					return [
						fg("accent", "enter") + " save   " + fg("accent", "esc") + " cancel",
						fg("dim", "* matches any characters, including /"),
					];
				}
				if (tab === "denied") {
					const denial = selectedDenial();
					const dimmed = denial && !denial.overridable;
					const dim = (text: string) => (dimmed ? fg("dim", text) : text);
					return [
						`${dim("(a) approve + retry")}   ${dim("(r) remember + retry")}   (w) write rule`,
						fg("dim", "↑↓ move · tab switch · ctrl+o expand · esc close"),
					];
				}
				if (tab === "remembered") {
					return [
						"(d) delete   (e) edit pattern",
						fg("dim", "↑↓ move · tab switch · esc close"),
					];
				}
				return ["", fg("dim", "↑↓ move · tab switch · esc close")];
			};

			/** Keep the list to MAX_ROWS, scrolling around the cursor. */
			const windowRows = (rows: PanelRow[], index: number): PanelRow[] => {
				if (rows.length <= MAX_ROWS) return rows;
				const half = Math.floor(MAX_ROWS / 2);
				const start = Math.max(0, Math.min(index - half, rows.length - MAX_ROWS));
				const out = rows.slice(start, start + MAX_ROWS);
				if (start > 0) out[0] = { text: fg("dim", `↑ ${start} more`) };
				const below = rows.length - start - MAX_ROWS;
				if (below > 0) out.push({ text: fg("dim", `↓ ${below} more`) });
				return out;
			};

			const renderBody = (width: number): string[] => {
				const narrow = width < NARROW;
				const body: string[] = [row(width, tabBar()), row(width, ""), separator(width, tab)];
				const list =
					tab === "denied"
						? denialRows(width)
						: tab === "remembered"
							? rememberedRows(width)
							: sessionRowsRendered(width);
				body.push(...windowRows(list, cursor).map((item) => row(width, item.text, item.highlight)));
				const factLines = facts(narrow, width);
				if (factLines.length > 0) {
					body.push(row(width, ""), separator(width, "selected"), ...factLines.map((item) => row(width, item.text)));
				}
				if (hint) body.push(row(width, ""), separator(width, "hint"), row(width, hint));
				if (editing) {
					body.push(row(width, ""), separator(width, "edit pattern"), row(width, `${editorValue}${GLYPH.cursor}`));
				}
				body.push(row(width, ""), separator(width, ""), ...actions().map((line) => row(width, line)));
				return body;
			};

			// ---- input -----------------------------------------------------

			const printable = (data: string): boolean => data.length === 1 && data >= " " && data !== "\x7f";

			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					cachedWidth = width;
					cachedLines = frame(width, renderBody(width));
					return cachedLines;
				},
				handleInput(data: string): void {
					if (editing) {
						if (data === "\r" || data === "\n") {
							commitRule();
							return;
						}
						if (data === "\x1b") {
							editing = false;
							hint = "";
							invalidate();
							tui.requestRender();
							return;
						}
						if (data === "\x7f" || data === "\b") {
							editorValue = editorValue.slice(0, -1);
							invalidate();
							tui.requestRender();
							return;
						}
						if (printable(data)) {
							editorValue += data;
							invalidate();
							tui.requestRender();
						}
						return;
					}

					if (data === "\x1b") {
						done(undefined);
						return;
					}
					if (data === "\t") {
						cycleTab(1);
						return;
					}
					if (data === "\x1b[Z") {
						cycleTab(-1);
						return;
					}
					if (data === "\x0f") {
						expanded = !expanded;
						invalidate();
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.up") || data === "k") {
						move(-1);
						return;
					}
					if (keybindings.matches(data, "tui.select.down") || data === "j") {
						move(1);
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
						if (tab === "denied") approve(false);
						return;
					}
					if (data === "a") {
						approve(false);
						return;
					}
					if (data === "r") {
						approve(true);
						return;
					}
					if (data === "w") {
						startRule();
						return;
					}
					if (data === "d" && tab === "remembered") {
						removeRemembered();
						return;
					}
					if (data === "e" && tab === "remembered") {
						editRemembered();
					}
				},
				invalidate,
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				minWidth: 48,
				maxHeight: "85%",
				margin: 1,
			},
			blocked: { kind: "question", message: "Review denied permissions" },
		} as never,
	);
}
