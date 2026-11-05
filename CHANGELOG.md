# Changelog

## [1.0.1](https://github.com/leourbina/pi-permission-review/compare/v1.0.0...v1.0.1) (2026-11-05)


### Bug Fixes

* keep the review link registered after a reload ([5915b26](https://github.com/leourbina/pi-permission-review/commit/5915b26dad256e95aea6fe76f34b24fc73fe9fd4))

## 1.0.0

First public release. The 0.9.x versions were local iterations and were never
published; everything below ships together.

- `/permissions` overlay with three tabs (Denied · Remembered · Session), a `label : value` fact pane, inline pattern editing, and a layout that condenses below 72 columns.
- Approve for the session, remember permanently, or write a policy rule; each option retries the refused call automatically.
- A denial leaves the list once you act on it, so the Denied tab is a queue of outstanding refusals rather than a log. If the retry is refused again, the fresh denial reappears as a new row.
- Denials come from the `permissions:decision` broadcast rather than the shared review log, which carries no session id on denial entries and so cannot tell whose refusals those are.
- `overridable` follows `resolution === "authorizer_denied"`, making a chain link's refusal distinguishable from a policy rule.
- Session approvals store their `sessionId`, so a `/reload` no longer voids them; entries for dead sessions are pruned.
- Long commands wrap in the detail pane (4 lines, or 24 with `ctrl+o`) instead of being truncated; list rows stay single-line with a right-aligned timestamp.
- Denial rows use the panel's full width, the selected row is painted with `selectedBg`, and the background fill is re-asserted after every SGR reset so a truncated row no longer loses its fill past the ellipsis.
- Detail pane: dim labels, accent command, warning-coloured denial reason, and a `!` marker on denials no authorizer can lift.
- State lives in `~/.pi/agent/permission-review/`, so an npm update cannot wipe approvals; the pre-0.8.0 location is still read as a fallback.
- Audit trail separates `permissions-review.approved` (your decision) from `permissions-review.allowed` (the link honouring it).

Known gaps: the panel is TUI-only, and the rule-writing path (`w`) has not been
exercised end to end against a path denial.
