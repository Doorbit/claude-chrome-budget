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

**Two browsers instead of one.**

- `chrome` — the default. Runs `--isolated`, so it starts from a clean profile and
  cannot inherit a pile of tabs from last week, and caps screenshots at 1024×768
  (configurable). Roughly halves the cost of an average screenshot.
- `chrome-pixel` — uncapped, for pixel-exact comparison work. Screenshots there
  must go to disk via `filePath`; comparing images belongs in a diff script, not in
  a context window.

Both launch Chrome lazily, so the second server costs nothing until it is used.

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

Set `enforcement` to `warn` to get the explanations without the refusals, or `off`
to disable it.

**A `browser` subagent.** It absorbs the snapshots and screenshots in its own
context and returns a verdict, which is what actually defuses the 805×. Delegate to
it whenever browser work runs longer than a couple of calls.

## Install

```bash
claude plugin marketplace add <this-repo>
claude plugin install chrome-budget@chrome-budget
```

Installing at user scope applies it to every project on the machine. Projects can
still layer their own rules on top; nothing here is project-specific.

If you already have a `chrome-devtools` server configured at user or project scope,
remove it — otherwise you end up running two browsers with different settings and
the guard only covers one of them.

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
