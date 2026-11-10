# Handoff — pi-permission-review fixes (2026-11-05)

## Where things stand

- Branch `fix/pattern-rules` holds the work, and **none of it is committed yet**. `main` is at `5915b26`.
- That work is copied into the live install at `~/.pi/agent/npm/node_modules/pi-permission-review`, so `/reload` in pi uses it.
  - The original npm 1.0.0 copy is backed up at `/tmp/claude-1000/-home-leonardourbina-code/bfb85938-b3d1-44ce-bab5-3ff8bd4edbd5/scratchpad/installed-1.0.0-backup`. The scratchpad may be cleared, so restore with `pi update` if that copy is gone.
  - A `pi update` will also overwrite the branch build with npm 1.0.0 until a new version is published.
- Checks:
  - `npm test` passes (35 tests).
  - `npm run check` passes, and so does `npm pack --dry-run`.
  - `tsc` passes against pi 1.5.0's type definitions. Repeat it by symlinking `node_modules` to `~/.pi/agent/install/releases/1.5.0/node_modules` for the run, then removing the symlink.
- **Not yet done:** nobody has driven the `/permissions` panel in a live pi TUI.
- `.oa-bus.json` is untracked and was not created by this work, so don't commit it.

## The original bug

The user could not save `git worktree remove *`. The old `sanitisePattern` only accepted the exact command or `<one word> *`, so it rejected the narrow rule and accepted the much broader `git *`.

## What changed

| File | Change |
| --- | --- |
| `pattern.ts` (new) | Copies the gate's matcher from `@gotgenes/pi-permission-system`'s `wildcard-matcher.ts`. There `*` crosses newlines (regex `s` flag), `?` matches one character, a trailing ` *` makes the arguments optional, and a leading `~` / `$HOME` is expanded on the pattern only. Also adds `isSimpleCommand`, `commandUnits` (naive split), and the subcommand-depth table from the gate's `bash-arity.ts`, with `git worktree`, `git stash`, `git remote` and `git submodule` added at depth 3. Adds `suggestBashPattern`, `checkBashShape` (first word must be literal), and `coversCommand`. |
| `approvals.ts` | Matching depends on which list an entry is in: `exact` compares verbatim, `pattern` uses wildcards. Bash patterns never match chained, piped, redirected or `$()` commands, because the review link sees the whole string. Adds `replaceEntry`; `countMatches` now takes the list kind. |
| `policy.ts` | `sanitisePattern` accepts any pattern with a literal first word that matches the command or one of its units. `checkPatternShape` validates without a denial (used by edit). `readPolicy` refuses a config with comments. `ruleConflicts` warns on overlap with a deny and on wildcard characters inside an exact command. `writeRule` moves the rule to the end of its section (the gate's last match wins) and keeps one `config.json.bak`. All pending-retry code is removed. |
| `panel.ts` | The editor is pi-tui's `Input`, so paste and emacs keys work. Result kinds are `approve` (session, exact), `remember` (editor writes to `approvals.json`), `write-rule` (editor; a second enter confirms when there are warnings), `edit` (in-place replace), and `delete`. |
| `index.ts` | Handles the new result kinds. `write-rule` no longer calls `ctx.reload()`, since the gate re-reads its config when the mtime changes; the retry is sent at once. A leftover `pending-retry.json` is deleted on start. `VERSION` is read from `package.json`. `a`/`r` no longer auto-add `matchedPattern`. |
| `denials.ts` | Dead log-reader code removed. Only the `Denial` type, `timeLabel` and `isLinkExcludedSurface` remain. |
| `scripts/check-manifest.mjs` | Follows every local import from `index.ts`, not just its direct ones. |
| `package.json` | `pattern.ts` added to `files`. New scripts: `test` (`node --experimental-strip-types --test test/*.test.ts`) and `check`. |
| CI, README | CI gains an `npm test` step. The README is updated for the new keys, the "prefer `w` for bash" advice, and the guardrails. |
| `test/` | `pattern.test.ts`, `approvals.test.ts`, `policy.test.ts`. |

## Facts verified in the gate's source

- Policy rules match per command unit: `cd x && git worktree remove y` is checked as `git worktree remove y`. The review link gets the whole command string.
- `FilePolicyLoader` caches by mtime, so config edits apply on the next call.
- The gate's config loader strips JSON comments.
- Bracketed paste reaches `handleInput` as `\x1b[200~…\x1b[201~`, which `Input` handles.

## Review findings (open-artifacts#1507, 2026-11-05)

- **Inner `*`**: `git -C * push *` also matched `git -C . config core.pager <program> push`. Fixed here: `checkBashShape` refuses a `*` anywhere but the end, and `entryMatches` ignores stored bash patterns with that shape. Tests cover both (37 pass).
- **Env prefix**: `GIT_CONFIG_PARAMETERS=… git status` matches the gate's `git status*` allow, because the **gate** strips leading assignments (`command-enumeration.ts:294` in `@gotgenes/pi-permission-system`). This extension's matcher already refuses it. No config rule can catch it, so it needs an upstream fix that treats leading assignments (at least `GIT_*`) as `ask`. Every `git …` allow in the live config is exposed until then.
- The live config still has `gh api *actions/permissions/workflow*`, which has an inner `*`. The gate still honours it, so it is worth narrowing or removing.

## Next steps

1. Test live in pi:
   - `/reload`, trigger a judge denial, `/permissions`, `w` on a `git worktree remove …` denial. The editor should suggest `git worktree remove *`; enter writes it to `~/.pi/agent/extensions/pi-permission-system/config.json` and retries.
   - Then try `r`, `e` on the Remembered tab, paste into the editor, and the deny-overlap warning (e.g. `sudo apt *`).
2. Check the panel rendering, since `Input.render` output is embedded in a background-filled row.
3. If it all works: commit with Conventional Commits (`fix:` for the pattern bug and `feat:` for editor and edit; the user may prefer one `fix:`), push, open a PR, merge, and release-please cuts 1.1.0 or 1.0.1. Commit or push only when the user asks.
4. The user's live `config.json` has one-off allow rules from earlier sessions (`rm -rf …/pi-permission-review`, `gh secret set *`, `npm publish *`, …), which may be worth pruning.
