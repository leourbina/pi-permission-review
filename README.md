# pi-permission-review

[![CI](https://github.com/leourbina/pi-permission-review/actions/workflows/ci.yml/badge.svg)](https://github.com/leourbina/pi-permission-review/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-permission-review.svg)](https://www.npmjs.com/package/pi-permission-review)

`/permissions` — review recently denied tool calls in [pi](https://pi.dev), allow one, remember it, or write a real policy rule, then retry the call.

The gap this fills: [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) logs every denial, but nothing reads that log back to you. With `verdicts: "allow-deny"` a refusal is silent — no dialog, no trace in the transcript. This extension turns those refusals into a list you can act on.

## Install

```bash
pi install npm:@gotgenes/pi-permission-system   # the gate (required)
pi install npm:pi-permission-review             # this extension
```

Then, in `~/.pi/agent/extensions/pi-permission-system/config.json`, put the review link **first** in the chain:

```jsonc
{
  "authorizerChain": ["review-approvals", "permission-judge"],
  "verdicts": "allow-deny"
}
```

Order matters: the review link must be consulted before the judge, or a judge denial lands before an approval can allow it.

`verdicts` must be `"allow-deny"` or `"allow-deny-defer"` for denials to happen at all. With `"allow-defer"` refusals become prompts, and with `"yoloMode": true` every `ask` is approved before the chain runs — this extension then has nothing to show.

Restart pi or run `/reload`.

## Use

Run something the gate refuses, then `/permissions`.

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | move |
| `tab` / `⇧tab` | Denied · Remembered · Session |
| `enter` / `a` | approve + retry, this session only |
| `r` | remember in `approvals.json` + retry |
| `w` | write a policy rule, reload, then retry |
| `d` | delete a remembered approval |
| `e` | edit a remembered pattern |
| `ctrl+o` | expand the wrapped command |
| `esc` | close |

Acting on a row removes it: the Denied tab is a queue of outstanding refusals, not a log. If the retry is refused again, the new denial appears as a fresh row.

Unavailable actions are dimmed rather than hidden: on a `policy` denial, `a` and `r` cannot work, because no chain link can lift a rule.

## How it works

Two mechanisms, because the gate has two kinds of refusal:

| `resolution` | Surfaces | Undo |
| --- | --- | --- |
| `authorizer_denied` | `bash`, `mcp`, `skill`, … | the link named `review-approvals` allows it |
| `policy_deny`, `user_denied` | `path`, `external_directory`, any rule match | a rule is written to the policy config, then `ctx.reload()` |

A rule write cannot be applied before the reload, and the retry must survive the reload, so the retry is parked in `pending-retry.json` and consumed on the next `session_start`.

Denials are collected from the `permissions:decision` broadcast, not from the review log: the log is shared by every pi session on the machine and carries no session id on denial entries, so it cannot tell whose refusals those are. The broadcast fires on this session's own bus.

## State

Kept in `~/.pi/agent/permission-review/` (respects `PI_CODING_AGENT_DIR`), never inside the package:

| File | Purpose |
| --- | --- |
| `approvals.json` | remembered calls and patterns, with `scope` and `sessionId` |
| `denials.json` | this session's denial feed, so `/reload` does not empty the panel |
| `pending-retry.json` | one-shot retry that survives a reload |

Every approval appends `permissions-review.approved` to the gate's own review log, and every use of an approval appends `permissions-review.allowed`, so there is one chronological trail of who allowed what.

## Guardrails

- never writes `yoloMode`, never broadens the policy to `"*": "allow"`
- remembered bash patterns are limited to the exact command, or one leading word plus ` *`
- filesystem rules are only ever the exact path, never a glob
- an unreadable or corrupt store is treated as empty: no crash, no accidental allow

## Limitations

- Review is per session. Refusals from other pi sessions are never listed.
- Reviewer probability scores are not shown: the gate records them only for deferred asks.
- Subagent child sessions are separate nodes and register their own link; a remembered approval still covers them, since the store is read from disk.
- The panel needs interactive TUI mode.

## Releases

Versions are cut by [release-please](https://github.com/googleapis/release-please). Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org) — `feat:`, `fix:`, `docs:`, `refactor:` — and release-please opens a release PR that bumps `package.json`, rewrites `CHANGELOG.md`, and tags the commit when merged. The tag triggers a publish job that runs `node scripts/check-manifest.mjs` and then `npm publish --provenance`.

CI on every push and PR runs the same manifest check plus `npm pack --dry-run`, which catches a manifest pi would refuse to load before it reaches the registry.

Publishing needs an `NPM_TOKEN` repository secret (an npm automation token). Provenance uses the workflow's `id-token: write` permission, which is already set.

## Uninstall

```bash
pi remove npm:pi-permission-review
# then set "authorizerChain": ["permission-judge"]
rm -rf ~/.pi/agent/permission-review
```

## License

MIT
