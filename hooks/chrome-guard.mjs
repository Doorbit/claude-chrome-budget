#!/usr/bin/env node
/**
 * PreToolUse guard for chrome-devtools-mcp.
 *
 * Every tool result a browser tool returns stays in the conversation for the
 * rest of the session and is re-sent with every following request. A single
 * accessibility snapshot is not a one-off cost, it is a tax on every
 * subsequent turn. This guard refuses the handful of calls that are reliably
 * expensive and points at the cheap equivalent, which chrome-devtools-mcp
 * already offers via `filePath`, `uid` and `types`.
 *
 * Configuration comes from the plugin's userConfig, exposed as
 * CLAUDE_PLUGIN_OPTION_* environment variables.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODE = (process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT || 'block').toLowerCase();
const MAX_OPEN_PAGES = Number(process.env.CLAUDE_PLUGIN_OPTION_MAX_OPEN_PAGES || 8);

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** Refusals are advice, not walls: every one names the cheaper call to make instead. */
function refuse(reason) {
  if (MODE === 'warn') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
    }));
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
  process.exit(0);
}

function stateFile(sessionId) {
  const dir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'chrome-budget');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* falls through to a read/write failure below, which we ignore */
  }
  return join(dir, `pages-${(sessionId || 'nosession').replace(/[^\w.-]/g, '_')}.json`);
}

/** Best-effort tab ledger. Drifts are harmless: the budget is generous and
 *  the only consequence of drift is an extra close_page. */
function adjustOpenPages(sessionId, delta) {
  const file = stateFile(sessionId);
  let open = 1; // the browser always starts with one page
  try {
    open = JSON.parse(readFileSync(file, 'utf8')).open ?? 1;
  } catch {
    /* no ledger yet */
  }
  const next = Math.max(1, open + delta);
  try {
    writeFileSync(file, JSON.stringify({ open: next }));
  } catch {
    /* a missing ledger degrades to no page budget, which is acceptable */
  }
  return open;
}

const input = readStdin();
if (!input || MODE === 'off') process.exit(0);

const [, server, tool] = String(input.tool_name || '').split('__');
if (!server || !tool || !server.includes('chrome')) process.exit(0);

const args = input.tool_input || {};
const session = input.session_id;
// The uncapped server exists solely for pixel-exact work, which belongs on
// disk and in a diff script — never in the context window.
const isPixelServer = server.includes('pixel');

if (args.includeSnapshot === true) {
  refuse(
    `${tool} was called with includeSnapshot: true, which appends the whole accessibility tree ` +
    `(~550 tokens, and it stays in context for the rest of the session). Drop the flag. ` +
    `To learn what changed on the page, call evaluate_script and return only the values you ` +
    `care about — a class name, a text content, a bounding box.`,
  );
}

if (tool === 'take_snapshot' && !args.filePath) {
  refuse(
    'A full page snapshot costs ~550 tokens and is re-sent on every following request. ' +
    'Two cheaper options: (1) evaluate_script that returns just the values you need — this is ' +
    'almost always the right call; (2) if you really need the whole tree, pass filePath to dump ' +
    'it to disk and then grep that file for the part you want.',
  );
}

if (tool === 'list_console_messages' && !args.types && !args.serviceWorkerId) {
  refuse(
    'An unfiltered console dump is mostly noise. Pass types (e.g. ["error"] or ["error","warning"]) ' +
    'and, for a busy page, pageSize — you can page through with pageIdx if the first page is not enough.',
  );
}

if (tool === 'take_screenshot' && !args.filePath) {
  if (isPixelServer) {
    refuse(
      'The chrome-pixel server is the uncapped one: its screenshots are full resolution and would ' +
      'cost thousands of tokens each in context. Pass filePath to write the image to disk, then ' +
      'compare images with a diff script and report the numbers. Use the default chrome server ' +
      'when you need to look at a page yourself.',
    );
  }
  if (args.fullPage === true) {
    refuse(
      'Full-page screenshots are the most expensive images there are, and image cost scales with ' +
      'pixel area. Pick one: uid to capture just the element you are judging, or filePath to write ' +
      'the image to disk instead of into the conversation. A plain viewport screenshot (neither ' +
      'flag) is fine when you genuinely need to look at the page.',
    );
  }
}

if (tool === 'take_snapshot' && isPixelServer && !args.filePath) {
  refuse('On the chrome-pixel server, snapshots must be written to disk via filePath.');
}

if (tool === 'new_page') {
  const openNow = adjustOpenPages(session, +1);
  if (openNow >= MAX_OPEN_PAGES) {
    adjustOpenPages(session, -1); // the call is refused, so do not count it
    refuse(
      `${openNow} pages are already open. Every navigation tool appends a list of all open tabs to ` +
      `its response, so each abandoned tab quietly taxes every later browser call. Close one you ` +
      `no longer need with close_page, or reuse the current page with navigate_page.`,
    );
  }
} else if (tool === 'close_page') {
  adjustOpenPages(session, -1);
}

process.exit(0);
