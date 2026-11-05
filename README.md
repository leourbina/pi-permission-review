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
| `enter` / `a` | approve this exact call for the session + retry |
| `r` | remember a call or pattern in `approvals.json` + retry |
| `w` | write a policy rule + retry (takes effect immediately) |
| `d` | delete a remembered approval |
| `e` | edit a remembered approval in place |
| `ctrl+o` | expand the wrapped command |
| `esc` | close |

Acting on a row removes it: the Denied tab is a queue of outstanding refusals, not a log. If the retry is refused again, the new denial appears as a fresh row.

Unavailable actions are dimmed rather than hidden: on a `policy` denial, `a` and `r` cannot work, because no chain link can lift a rule.

`r` and `w` open a pattern editor seeded with the narrowest useful pattern — the command's subcommand plus ` *`, e.g. `git worktree remove *` (same depth table as the gate's session approvals). The editor is pi's own single-line input: paste works, and so do the usual emacs keys. Patterns use the gate's syntax: `*` matches anything (including `/` and newlines), `?` one character, and a trailing ` *` also matches the bare command.

**Prefer `w` for bash.** The gate evaluates a policy rule per command unit, so `git worktree remove *` also covers `cd ~/code && git worktree remove x`. A remembered pattern is matched by the review link against the *whole* command string, so it only applies to single plain commands — anything with `&&`, `;`, `|`, redirects or `$(…)` is left to the judge, so a pattern can never ride along on a chained command.

## How it works

Two mechanisms, because the gate has two kinds of refusal:

| `resolution` | Surfaces | Undo |
| --- | --- | --- |
| `authorizer_denied` | `bash`, `mcp`, `skill`, … | the link named `review-approvals` allows it |
| `policy_deny`, `user_denied` | `path`, `external_directory`, any rule match | a rule is written to the policy config |

The gate re-reads its config whenever the file's mtime changes, so a written rule applies to the very next call and the retry is sent straight away. The rule is moved to the end of its section, because the gate takes the last matching rule.

Denials are collected from the `permissions:decision` broadcast, not from the review log: the log is shared by every pi session on the machine and carries no session id on denial entries, so it cannot tell whose refusals those are. The broadcast fires on this session's own bus.

## State

Kept in `~/.pi/agent/permission-review/` (respects `PI_CODING_AGENT_DIR`), never inside the package:

| File | Purpose |
| --- | --- |
| `approvals.json` | remembered calls and patterns, with `scope` and `sessionId` |
| `denials.json` | this session's denial feed, so `/reload` does not empty the panel |

Every approval appends `permissions-review.approved` to the gate's own review log, and every use of an approval appends `permissions-review.allowed`, so there is one chronological trail of who allowed what.

## Guardrails

- never writes `yoloMode`, never broadens the policy to `"*": "allow"`
- a bash pattern must start with a literal word and must match the refused command (or one of its units), so `*`, `g*` or an unrelated pattern is refused; `*` may only end a bash pattern, because an inner one spans arguments (`git -C * push *` would also match `git -C . config core.pager <program> push`), and a stored pattern with an inner `*` never matches
- remembered bash patterns never match chained, piped or redirected commands
- writing an allow that overlaps an existing `deny` (`sudo apt *` vs `sudo *`) shows a warning and needs a second `enter`
- a policy config with comments is never rewritten (the comments would be lost); the previous config is kept as `config.json.bak`
- filesystem rules are only ever the exact path, never a glob
- an unreadable or corrupt store is treated as empty: no crash, no accidental allow

## Limitations

- Review is per session. Refusals from other pi sessions are never listed.
- Reviewer probability scores are not shown: the gate records them only for deferred asks.
- Subagent child sessions are separate nodes and register their own link; a remembered approval still covers them, since the store is read from disk.
- The panel needs interactive TUI mode.

## Releases

Versions are cut by [release-please](https://github.com/googleapis/release-please). Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org) — `feat:`, `fix:`, `docs:`, `refactor:` — and release-please opens a release PR that bumps `package.json`, rewrites `CHANGELOG.md`, and tags the commit when merged. The tag triggers a publish job that runs `node scripts/check-manifest.mjs` and then `npm publish --provenance`.

CI on every push and PR runs the same manifest check, `npm test` (node's built-in runner with type stripping, no dependencies), and `npm pack --dry-run`, which catches a manifest pi would refuse to load before it reaches the registry.

Publishing needs an `NPM_TOKEN` repository secret (an npm automation token). Provenance uses the workflow's `id-token: write` permission, which is already set.

## Uninstall

```bash
pi remove npm:pi-permission-review
# then set "authorizerChain": ["permission-judge"]
rm -rf ~/.pi/agent/permission-review
```

## License

MIT
