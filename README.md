# @airewards/cli-wrapper

Universal terminal proxy for CLI AI agents. Wrap any agent — `claude`, `cline`,
`aider`, anything — and earn AIRewards credit for the time it spends thinking,
in **any** terminal: iTerm2, Terminal.app, tmux, an IDE's integrated shell, ssh.

Unlike an editor extension, this hooks the *process*, not the editor, so it
needs no host integration and no terminal cooperation. It runs the agent on a
pseudo-terminal, which is what lets it keep the agent's terminal intact while
still seeing — and rewriting — everything the agent prints.

```
$ codex "refactor this module"
⋯ agent output, on a screen one row shorter than your terminal ⋯
✨ [Sponsored] Acme Cloud — free tier for CLI agents        ← a row the agent never sees
```

The agent's own first frame is the first thing you see: nothing is printed before
it is spawned. The sponsored line then lives either on a row withheld from the
agent — one it was never told about, and cannot scroll into — or, where the window
has no row to spare, on a status row the agent had already marked disposable.
Either way the screen it draws is the screen it would have drawn unwrapped.

## Install

```bash
pnpm add -g @airewards/cli-wrapper
airewards setup --api-key air_dev_…
```

`setup` appends a managed block to your shell rc file that routes every AI agent
it finds on your PATH through the proxy:

```sh
# >>> airewards >>>
# Managed by `airewards setup`. Re-run it to update, or --remove to undo.
alias claude="airewards run claude"
alias cline="airewards run cline"
# <<< airewards <<<
```

Open a new terminal and keep using your agents exactly as before.

Get a developer API key from the AIRewards dashboard under
**Profile → Developer Settings**.

## Claude Code is monetised natively

Claude Code draws a persistent footer of its own, which puts its spinner in the
middle of a repaint rather than on the last row of a chunk — exactly the shape
the injector refuses to touch. So Claude is not intercepted at all. Instead
`setup` asks Claude to render the ad itself, by adding two keys to
`~/.claude/settings.json`:

```json
{
  "spinnerVerbs": { "mode": "replace", "verbs": ["✨ [Sponsored] Fetching ad..."] },
  "statusLine": {
    "type": "command",
    "command": "node /Users/you/.airewards/claude-hook.js",
    "padding": 0
  }
}
```

`~/.airewards/claude-hook.js` is a launcher for `src/claude-hook.ts`: Claude runs
it on its render loop and prints whatever single line it writes on stdout. Every
other setting in the file is preserved, the original is copied to
`settings.json.airewards.bak` before the first edit, `--remove` takes out only
what is still recognisable as ours — our `statusLine`, and our verbs out of the
shared `spinnerVerbs` array, leaving anything another tool put there — and
`--no-claude-hook` skips the whole
thing. `CLAUDE_CONFIG_DIR` is honoured. `airewards run claude` then relays on
inherited descriptors with no pty, no injection and no banner — the footer is
already carrying the ad.

The verb `setup` writes is only a placeholder, because there is no ad in hand at
install time and blocking on the network to get one would be the wrong trade.
Claude reads its spinner verbs from `settings.json` rather than from the hook's
stdout, so the hook patches the live copy in — `✨ [Sponsored] <text> | <url>`,
as plain text, since that string goes through Claude's own renderer rather than
to the terminal. The write is atomic (temp file plus rename, preserving the
file's mode) and touches only `spinnerVerbs`, so your models, themes and
permissions are never disturbed by a background process.

`spinnerVerbs.verbs` is an array, and other monetised status lines write their
own verb into the same key from the same render loop. Two hooks each replacing
the whole array is a write-war — whichever ran last wins the frame, and the
spinner flickers between vendors. So every write is a **merge**: verbs that are
not ours are carried through untouched, verbs that are ours collapse to the one
live ad, and ours goes last.

```json
"verbs": ["Follow my friend on Youtube please @go_to_rob", "✨ [Sponsored] SAKIB | https://…"]
```

Claude then cycles through both and neither tool has anything left to overwrite.
The merge runs once a tick, after the status line we chained has exited, so its
write is already on disk to be preserved rather than clobbered — and a verb
something else drops is back within one frame instead of one rotation. It only
writes when the array would actually change, so the steady state costs a read
and nothing more, and it only writes while `statusLine` is still ours.

### Your own status line keeps working

Claude has exactly one `statusLine` slot, so installing ours displaces whatever
was in it — a context-usage HUD, a cost tracker, another vendor's hook. The slot
cannot be shared, but the command can. `setup` copies the entry it displaced to
`~/.airewards/prev-statusline.json` (mode `0600`), the hook runs that command on
every tick and prints its rows *above* the ad, and `--remove` puts it back in
`settings.json` and deletes the copy. Being replaced by us is invisible except
for the extra row.

Running someone else's program on the render loop is the one thing here that can
hang, so it is bounded on every side:

- **200ms, then killed by process group.** Claude will not draw the footer until
  the hook exits, so the deadline is hard: a tool that hangs — a network call, a
  lock, a read from a stdin nobody is writing to — loses its row rather than
  freezing the footer. The kill targets the group, so a `sh -c 'a | b'` pipeline
  loses both stages instead of leaving `b` orphaned and holding the pipe.
- **Started first, awaited last.** The spawn happens before the config or the ad
  cache is even read, so the tool's latency overlaps ours instead of adding to it.
- **Output is capped at 8KB and discarded if we killed it.** Truncated output can
  be cut mid-escape-sequence, and a dangling colour or hyperlink would bleed into
  the ad line underneath. `stderr` is dropped so a noisy tool cannot become part
  of the footer; `stdin` is inherited, so status lines that read Claude's session
  JSON still get it.
- **Never our own launcher.** A capture pointing at `claude-hook.js` is refused,
  so no install can make the chain recurse.
- **The ad renders either way.** A broken, missing or slow tool costs its own row
  and nothing else — and the chained rows are printed even when we have no API
  key and no ad, because a status line we displaced has to run regardless.

Because Claude re-runs the hook every few hundred milliseconds as a fresh
process, it never blocks on the network in the steady state:
- The ad lives in `~/.airewards/ad_cache.json` and is printed straight from
  there (~30ms, no request), then refreshed behind the render once it is 60s
  old. Only the very first tick of a cold cache waits on the API.
- Dwell is accumulated across ticks, each capped at 2s, so time when Claude was
  not drawing cannot be billed. At 5s the client begins the v2 challenge and
  heartbeat sequence while the sponsored row remains visible. The server uses
  receive times and risk scoring before creating provisional accounting; the
  cache is marked so an ad is never credited twice.
- Every failure — no key, unreadable cache, offline API, rejected impression —
  prints nothing and exits 0, because the alternative is an error message
  redrawn in your editor's footer on every frame.

## Commands

```
airewards run <command> [args…]   Run <command> through the proxy
airewards setup [options]         Alias your AI agents through the proxy
airewards --version               Print the version
```

### `setup` options

| Option              | Effect                                                     |
| ------------------- | ---------------------------------------------------------- |
| `--api-key <key>`   | Store the key in `~/.airewards/config.json` (mode `0600`)   |
| `--agents <a,b,c>`  | Alias these commands instead of auto-detecting on PATH      |
| `--shell <zsh\|bash>` | Override shell detection                                  |
| `--no-claude-hook`  | Skip Claude Code's native `statusLine` hook                 |
| `--dry-run`         | Print what would change; write nothing                      |
| `--remove`          | Remove the managed alias block and the native hook          |

Editing a dotfile is the most invasive thing this package does, so `setup` is
idempotent (re-running replaces the block, never duplicates it), reversible
(`--remove`, plus a one-time `<rc>.airewards.bak`), previewable (`--dry-run`),
and never aliases a command you do not have installed. It honours `$ZDOTDIR`
for zsh. The same rules apply to `~/.claude/settings.json`.

## Configuration

| Source                                    | Purpose                        |
| ----------------------------------------- | ------------------------------ |
| `AIREWARDS_API_KEY`                        | Overrides the stored key       |
| `AIREWARDS_API_BASE_URL`                   | Overrides the API origin       |
| `AIREWARDS_PTY=0`                          | Forces the plain relay (no interception) |
| `AIREWARDS_RESERVED_ROW=0`                 | Keeps your full terminal height; borrows a status line instead |
| `CLAUDE_CONFIG_DIR`                        | Where Claude Code's `settings.json` lives |
| `~/.airewards/config.json` (`0600`)        | `{ "apiKey", "baseUrl" }`      |
| `~/.airewards/ad_cache.json` (`0600`)      | Current ad + dwell state for the Claude hook |
| `~/.airewards/claude-hook.js`              | Launcher Claude's `statusLine` invokes |
| `~/.airewards/prev-statusline.json` (`0600`) | The `statusLine` we displaced, chained by the hook and restored by `--remove` |

## How it works

Everything below is the proxy path, which every agent except Claude Code takes;
Claude uses the native hook described above.

1. `GET /v1/ads/current?platform=cli` is fetched first, and nothing at all is
   printed: an interactive agent takes the terminal over with its own first
   frame, so a banner above it would be scrolled out of view before you could
   read it. The ad is held for whichever interception strategy runs. The request
   is hard-bounded by a 4s timeout, and skipped entirely when you have no API key
   or stdout is not a TTY.
2. `run` spawns the target binary on a **pseudo-terminal**. The child's three
   descriptors are a pty slave, so from inside it the world looks exactly like a
   terminal — `isTTY` is true, there is a window size (and it follows yours on
   resize), raw mode works, and `^C` becomes a SIGINT through the pty's own line
   discipline. Interactive TUIs and REPLs (`claude`, `aider`) behave as they do
   unwrapped.
3. Because the pty *master* belongs to the proxy, every byte the agent writes
   passes through it — and which row the ad goes on is then a choice between two
   strategies.
4. **The reserved row** is the default wherever your window can spare a row, and
   it is what monetises the agents built on absolute positioning (`codex`,
   `cline`), which own their screen and have no throwaway row to lend. The pty is
   allocated one row shorter than your terminal, so every window size the agent
   measures stops one row above the bottom; the scrolling region is fenced with
   DECSTBM (`\x1b[1;<rows-1>r`) so nothing it does can scroll into that row; and
   the ad is painted there with save-cursor / absolute-position / write / erase /
   restore-cursor, which leaves the agent's own cursor exactly where it was. Any
   DECSTBM the agent emits — including the `\x1b[r` full reset a TUI uses on the
   way out of a mode — is rewritten in the stream to keep the fence. See
   `src/reserved-row.ts`.
5. **The borrowed status line** is the fallback, for a window too short to give a
   row away (under 3 rows) or `AIREWARDS_RESERVED_ROW=0`. While the agent is
   waiting on a model it parks a status line on screen — `⠙ Thinking…` — and the
   proxy rewrites that one line into a sponsored one with `\r\x1b[K`, then hands
   it straight back the moment real output resumes. Agents that park nothing are
   picked up from the *input* side instead: pressing Enter fetches a fresh ad and
   borrows the row the agent left the cursor on, with an 8s cooldown so a dialog
   confirmation or a multi-line composer cannot turn into a burst of requests.
   See `src/injector.ts`.
6. Either way, an impression first needs 5 seconds of ad genuinely on screen.
   The client then sends a v2 challenge and consecutive visibility heartbeats;
   the server validates their receive times and risk scores before it creates
   provisional accounting. On a borrowed
   row that means the sponsored line is still the one there when the timer fires —
   an ad the agent repainted over half a frame later earns nothing. On the
   reserved row the ad cannot be overwritten, so what is checked instead is that
   the row never stopped being ours: no editor took the alternate screen, no
   resize moved it. The copy rotates every 60s, which is what makes the next
   impression possible at all — a tracking signature is single-use.
7. The child's exit code — including `128 + signal` — is propagated verbatim, and
   the reserved row is cleared and the full scrolling region restored before the
   terminal is handed back.

The plain relay is the one path that still prints a static banner above the
command, because there is nothing to intercept on it — this process is not in the
stream — and it is what monetises a long non-interactive command (`build`,
`test`) that never paints a status line to borrow. It is credited the same way:
5 seconds of the command still running.

### What it will not touch

Both strategies stop dead inside the **alternate screen buffer** (`\x1b[?1049h` —
`vim`, `nano`, `less`, a full-screen diff viewer). That buffer is a different
screen with its own margins, so the reserved row does not exist on it in any
sense worth reasoning about and there is no throwaway row to borrow either;
painting there would write into an editor's own canvas. Painting resumes on
`\x1b[?1049l`, and the reserved row re-issues its fence on the way back, because
a terminal that saved margins on the way in restored the agent's rather than
ours. Nothing is earned while the valve is shut.

Borrowing a status line is narrower still, since the row belongs to the agent: it
refuses on any **multi-line repaint** (cursor-up, absolute positioning,
erase-display) and on a chunk cut mid-escape-sequence, and generic status words
like "working" only count when the agent also ellipsised them. The sponsored line
is clipped to your terminal width under both strategies so it can never wrap onto
a second row.

### It never breaks your workflow

Every ad-related failure degrades to a plain relay on inherited descriptors,
with this process entirely out of the stream: no API key, no ad, a 404, a 500,
an offline or packet-dropping network — and, specifically for the pty, a
`node-pty` addon that will not load on your platform, a pty that cannot be
allocated, a command that is not on your PATH, or `AIREWARDS_PTY=0`. Nothing is
printed and no pty is created when stdout is not a TTY, so piped and redirected
output is byte-identical to running the command bare — and an ad nobody could
see is never credited. The reserved row is given up the same way: a window too
short for it, or `AIREWARDS_RESERVED_ROW=0`, falls back to borrowing a status
line rather than to nothing.

## Notes

This package talks to the API with `fetch` directly rather than through
`@airewards/sdk`. The SDK exposes raw TypeScript source and depends on
`@airewards/api` and hono, which a `tsc`-only, globally-installed binary cannot
consume without adding a bundler. The same reasoning applies to
`apps/vscode-extension`.

The single runtime dependency is `node-pty`, and it is optional in practice: it
is loaded through `createRequire` inside a `try`, never a static `import`, so a
native addon that fails to load degrades to the inherited-fd relay instead of
taking the process down. Its prebuilt `spawn-helper` ships without an execute
bit, which would make every `pty.spawn` fail with `posix_spawnp failed`;
`scripts/ensure-pty-helper.mjs` restores it on `postinstall`.

## Verifying by hand

`scripts/pty-harness/` in the repository root drives the proxy through a pty of
its own against a fake ad server and a fake spinner-emitting agent:

```bash
node scripts/pty-harness/verify.mjs     # injection, cleanup, fallbacks, stdin
node scripts/pty-harness/fidelity.mjs   # wrapped output vs. unwrapped, pty and piped
```

The native Claude hook needs neither, since it is a plain script whose output is
its whole contract. Point it at a scratch home and run it a few times:

```bash
HOME=/tmp/scratch AIREWARDS_API_KEY=air_dev_… node ~/.airewards/claude-hook.js
cat /tmp/scratch/.airewards/ad_cache.json   # renderedMs climbs; impressionRecorded flips at 5s
```
