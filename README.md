# Chrome MCP Budget

A Claude Code plugin that stops [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
from flooding the model's context.

The browser is often the only way to answer a question, so the goal is not to use it
less. It is to pay less for each answer.

## The problem, measured

Run the included report against your own transcripts:

```bash
node scripts/chrome-token-report.mjs
```

On the machine this plugin was built for, across 209 sessions:

| | |
|---|---|
| Tokens written into conversations | 4.6M |
| Tokens **carried** — re-sent on every later request | 3.7B (**805×**) |
| Screenshots | 1,593, averaging 1,498 tokens each |
| Share of the text output that was the actual answer | **29 %** |

Three things drive that:

**Browser results are not a one-off cost.** Anything a tool returns stays in the
conversation and is re-sent with every following request. A snapshot taken in the
first minute is paid for again on every turn after it. That is where the 805×
comes from, and it is why isolating browser work in a subagent is worth more than
shrinking any individual response.

**Most of the text is not the answer.** 71 % of it is context the server appends
automatically. The largest single block is `## Pages` — a listing of every open
tab, attached to the response of every navigation tool. Measured at an average of
10 open tabs, and it grows: in the sampled data 830 pages were opened against 242
closed, and each leaked tab quietly taxes every later browser call.

**Images are billed by area, not by bytes.** Roughly `width × height / 750`
tokens. Switching PNG to WebP at quality 60 makes the file smaller and changes the
token cost by nothing at all. Only the pixel dimensions matter.

## What the plugin does

**Four browsers instead of one**, because the four jobs have genuinely different
needs. All run `--isolated`, so each starts from a clean profile instead of
inheriting a pile of tabs from last week, and all launch Chrome lazily — a server
you do not use costs nothing.

- `chrome` — the default, for looking at and driving a page. Caps screenshots at
  1024×768 (configurable), which roughly halves the cost of an average screenshot.
- `chrome-pixel` — uncapped, for pixel-exact comparison. Screenshots there must go
  to disk via `filePath`: comparing two renderings belongs in a diff script, which
  is both cheaper and more accurate than comparing them by eye.
- `chrome-debug` — performance traces, memory and network forensics. This is the
  only server with `--memoryDebugging`, so the twelve heap-analysis tools
  (`get_heapsnapshot_summary`, `compare_heapsnapshots`, `query_heapsnapshot_objects`
  and the rest) exist only here. Without it you can capture a heap snapshot but not
  analyse one.
- `chrome-visible` — the one browser with a window, whatever the `headless` option
  says: for pages where a person has to do something, above all signing in. It
  carries the default screenshot cap and leaves out the performance and emulation
  tools, which nobody needs for a hand-over.

**A guard that corrects the call rather than refusing it.** A `PreToolUse` hook
rewrites the handful of call shapes that are reliably expensive into the cheap
equivalent chrome-devtools-mcp already supports, and lets the call through with a
note saying what changed:

| Call | Becomes |
|---|---|
| any tool with `includeSnapshot: true` | the flag is dropped |
| `take_snapshot` without `filePath` | written to `.chrome-budget/` instead of into the conversation |
| `take_screenshot` with `fullPage`, or anything on `chrome-pixel` | same |
| `take_heapsnapshot` without `filePath` | same |
| `get_network_request` inline, on `chrome-debug` | body written to `responseFilePath` |
| `lighthouse_audit` without `outputDirPath` | report written to disk |
| `list_console_messages` without `types` | narrowed to errors and warnings |
| `list_network_requests` unfiltered | a note suggesting `resourceTypes` — no rewrite |

Rewriting rather than refusing is deliberate, and it was not the first design. A
refusal costs a round trip, and the advice it gave — pass `filePath` — walked
models into a second wall: the server writes only inside the negotiated workspace
roots, while an agent's natural choice is its own scratchpad. The transcripts show
what follows. The model complies, gets `Access denied: not within any of the
configured workspace roots`, concludes that `filePath` does not work, and returns
to the inline call the guard was trying to prevent. Picking the path here removes
both problems.

Artefacts land in `<project>/.chrome-budget/`, which the hook creates with a
`.gitignore` of `*`.

Every rule that applies is applied, and the corrected call goes through. An
earlier version emitted on the first match, so a screenshot carrying a stray
`includeSnapshot` had the flag stripped and then escaped the rule that would have
written it to disk — the most expensive call shape slipping through the narrowest
gap.

The guard holds no state and never grants or withholds a permission. It returns a
corrected input and a note, and leaves the permission decision where it belongs.
An earlier version tracked open tabs and refused past a budget; that count could
not be made accurate — one browser is shared by every agent in a session, and a
page closed by anything other than `close_page` is invisible to a hook — and
refusing on a number that may be wrong left subagents with no way out. `--isolated`
does the real work there anyway: it took the measured tab count from an average of
11.5 to 2.4.

Set `enforcement` to `warn` for the explanations without the rewrites, or `off` to
disable the hook.

**Browsers that do not outlive their use.** chrome-devtools-mcp will not close the
last page, and the Chrome it launched lives as long as the server — which is as
long as the Claude session. An agent that closes every tab it opened still leaves a
window on `about:blank` behind, measured at 700–900 MB each and held for as long as
the session stays open, which for a forgotten terminal tab can be weeks. A
`PostToolUse` hook on `close_page` ends that server's Chrome once nothing but blank
tabs remain, or when the agent asks to close the only page there is. The server
notices the browser is gone and launches a fresh one on the next call, so nothing
breaks; what is lost is the state — the next call starts from a clean profile and
has to log in again. The hook only ever touches the browser of the server that
answered, in its own session, and does nothing when it cannot tell which one that
is. One gap remains: a browser is shared by every agent in a session, and a page
another agent opens in the half second between `close_page` and the hook goes down
with it — that agent's next call then reports the restart. Set `close_idle_browser`
to `false` to keep idle browsers around.

**The browsers run without a window.** A launched Chrome makes itself the front
app, so every agent that opened a page used to take the keyboard from whatever you
were typing in. Measured on macOS: Chrome becomes frontmost at launch and stays
there through every call; starting it in the background (`open -g`) and attaching
with `--browserUrl` does not help, because Chrome activates itself. Headless Chrome
never changes the front app, even on `select_page` with `bringToFront`, and WebGL
still runs on the real GPU (ANGLE on Metal, frame times within noise of a windowed
browser). The viewport is fixed at 1280×800 so pages lay out the same on every
machine. What you give up: you cannot watch the agent work, headless Chrome has no
WebGPU, and the user agent says `HeadlessChrome`. Set `headless` to `false` when you
need any of those back.

What you also give up is the person: nobody can sign in on a page they cannot see.
So when `new_page` or `navigate_page` on a headless server lands on a sign-in page
(a host such as `auth.` or `login.`, or a path such as `/login` or an OAuth/OIDC
authorise endpoint), a `PostToolUse` hook tells the model to open that URL on
`chrome-visible` and have the person sign in there. It only advises: a model with
credentials of its own carries on where it is. Logins do not carry over between
servers — each runs its own isolated profile.

The servers also run with `--no-usage-statistics`. With statistics on, every server
starts a separate telemetry watchdog to report usage to Google — three processes per
session, about 35 MB each, measured at 1.8 GB across 18 open sessions.

**Two subagents.** They absorb the snapshots, screenshots and traces in their own
context and return a finding, which is what actually defuses the 805×.

- `browser` — ordinary runtime verification. Delegate to it whenever browser work
  runs longer than a couple of calls.
- `browser-debug` — traces, heap comparison, network forensics, lighthouse. These
  produce the largest output the tooling can produce, so they get their own context
  and their own instrument list.

## Install

```bash
claude plugin marketplace add Doorbit/claude-chrome-budget
claude plugin install chrome-budget@chrome-budget --scope user \
  --config screenshot_max_width=1024 --config screenshot_max_height=768
```

User scope applies it to every project on the machine. Projects can still layer
their own rules on top; nothing here is project-specific.

Then remove any `chrome-devtools` server you already have, or you end up running a
second browser that the guard does not cover and whose screenshots are uncapped:

```bash
claude mcp remove chrome-devtools -s user
claude mcp remove chrome-devtools -s local   # from each project that has one
claude mcp list                              # should report no conflicting scopes
```

Verify the install:

```bash
claude plugin details chrome-budget
```

Expect two agents (`browser`, `browser-debug`), a `PreToolUse` and a `PostToolUse` hook, and three MCP
servers, at a
standing context cost of a few hundred tokens — the agents' descriptions in the
subagent list. The Chrome processes launch lazily, so a server you do not use
costs nothing.

The MCP tool schemas are a separate question. Claude Code resolves them on demand
where tool search is available, which is why `claude plugin details` reports them
as not counted — check that on your own setup before assuming it. Without it,
three servers mean three sets of tool definitions on every request, and you would
want `--slim` or fewer servers instead.

## Where the files go

Several of the rules push output to disk, so it is worth knowing where it lands.
chrome-devtools-mcp writes only inside the MCP roots the client negotiated — in
practice the project directory. If the client negotiates no roots, writes are
confined to the OS temp directory instead. A refused path is almost always this,
not a permissions problem: write to the temp directory and read it back from there.

Clean up what you write. Network dumps in particular can contain authorization
headers and response bodies.

## Configure

Via `claude plugin install --config`, or the plugin's settings:

| Option | Default | Effect |
|---|---|---|
| `screenshot_max_width` | 1024 | Downscale threshold. The only setting that reduces image tokens. |
| `screenshot_max_height` | 768 | Same, for height. Smaller scale factor wins. |
| `enforcement` | `correct` | `correct` rewrites, `warn` only explains, `off` disables. Nothing is refused. |
| `headless` | `true` | Run `chrome`, `chrome-pixel` and `chrome-debug` without a window, so they never take the focus. `false` shows their windows (needed to watch the agent, or for WebGPU). `chrome-visible` always has one. |
| `close_idle_browser` | `true` | Close a browser once `close_page` leaves only blank tabs. `false` keeps it, and its logins, until the session ends. |

## Verify it is working

```bash
node scripts/chrome-token-report.mjs --since 2026-09   # after installing
```

Compare `avg` for `take_screenshot` and the size of the `## Pages` block against a
period before installation.

## Test

```bash
node --test
```

## License

MIT
