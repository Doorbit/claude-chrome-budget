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

**Three browsers instead of one**, because the three jobs have genuinely different
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

**A guard that redirects rather than forbids.** A `PreToolUse` hook refuses the
handful of call shapes that are reliably expensive, and every refusal names the
cheaper call that answers the same question:

| Refused | Because | Instead |
|---|---|---|
| any tool with `includeSnapshot: true` | appends the whole a11y tree (~550 tokens, permanently) | `evaluate_script` returning the specific value |
| `take_snapshot` without `filePath` | same cost, every time | dump to disk and grep it |
| `list_console_messages` without `types` | unfiltered dumps are mostly noise | `types: ["error"]`, plus `pageSize` |
| `take_screenshot` with `fullPage` and no `filePath` | the most expensive image shape there is | `uid` for one element, or `filePath` |
| `new_page` beyond the page budget | every open tab is appended to every navigation response | `close_page`, or reuse via `navigate_page` |
| `take_heapsnapshot` without `filePath` | a heap snapshot inline is unusable anyway | write it, then analyse the file |
| `list_network_requests` unfiltered | the whole log is rarely the question | `resourceTypes`, or `pageSize` + `pageIdx` |
| `get_network_request` inline, on `chrome-debug` | response bodies average ~2500 tokens | `responseFilePath`, then `jq` |
| `lighthouse_audit` without `outputDirPath` | reports are far too large to read inline | write it, then read the audits you need |

Set `enforcement` to `warn` to get the explanations without the refusals, or `off`
to disable it.

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
  --config screenshot_max_width=1024 --config screenshot_max_height=768 \
  --config max_open_pages=8 --config enforcement=block
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

Expect two agents (`browser`, `browser-debug`), one `PreToolUse` hook, and three MCP
servers, at a
standing context cost of a few hundred tokens — the agents' descriptions in the
subagent list. Everything else is resolved at runtime and costs nothing until
used.

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
| `max_open_pages` | 8 | Page budget before `new_page` is refused. |
| `enforcement` | `block` | `block`, `warn` or `off`. |

## Verify it is working

```bash
node scripts/chrome-token-report.mjs --since 2026-09   # after installing
```

Compare `avg` for `take_screenshot` and the size of the `## Pages` block against a
period before installation.

## License

MIT
