#!/usr/bin/env node
/**
 * PreToolUse guard for chrome-devtools-mcp.
 *
 * Every tool result a browser tool returns stays in the conversation for the
 * rest of the session and is re-sent with every following request. A single
 * accessibility snapshot is not a one-off cost, it is a tax on every
 * subsequent turn.
 *
 * Where a call has a cheap equivalent that chrome-devtools-mcp already
 * supports — `filePath`, `types`, `pageSize` — this guard fills it in and lets
 * the call through, rather than refusing and hoping the model guesses the same
 * fix. Refusing turns out to be the worse option twice over: it costs a round
 * trip, and a model that picks an unwritable path gets refused a second time by
 * the server and then abandons `filePath` altogether, landing back on the
 * expensive inline call. Refusal is kept only where no safe rewrite exists.
 *
 * Configuration comes from the plugin's userConfig, exposed as
 * CLAUDE_PLUGIN_OPTION_* environment variables.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const MODE = (process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT || 'block').toLowerCase();
const MAX_OPEN_PAGES = Number(process.env.CLAUDE_PLUGIN_OPTION_MAX_OPEN_PAGES || 8);
const OUT_DIR_NAME = '.chrome-budget';

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', ...payload },
  }));
  process.exit(0);
}

/** Let the call through with a corrected input, and say what changed. */
function rewrite(updatedInput, note) {
  if (MODE === 'warn') emit({ additionalContext: note });
  emit({ permissionDecision: 'allow', updatedInput, additionalContext: note });
}

/** Only for calls with no safe rewrite. */
function refuse(reason) {
  if (MODE === 'warn') emit({ additionalContext: reason });
  emit({ permissionDecision: 'deny', permissionDecisionReason: reason });
}

/**
 * chrome-devtools-mcp writes only inside the workspace roots the client
 * negotiated. An agent's own scratchpad is outside them, which is how a model
 * that does the right thing still gets an "Access denied: not within any of the
 * configured workspace roots" — so pick the path here instead of describing it.
 */
function outputPath(cwd, tool, extension) {
  const base = cwd && isAbsolute(cwd) ? cwd : tmpdir();
  const dir = join(base, OUT_DIR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
    // Keep the artefacts out of version control without asking anyone to.
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  } catch {
    return join(tmpdir(), `${tool}-${Date.now()}.${extension}`);
  }
  return join(dir, `${tool}-${Date.now()}.${extension}`);
}

function stateFile(sessionId) {
  const dir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'chrome-budget');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* a failed write below is handled by falling back to no page budget */
  }
  return join(dir, `pages-${(sessionId || 'nosession').replace(/[^\w.-]/g, '_')}.json`);
}

/** Best-effort tab ledger. Drift is harmless: the budget is generous and the
 *  only consequence is an extra close_page. */
function adjustOpenPages(sessionId, delta) {
  const file = stateFile(sessionId);
  let open = 1; // the browser always starts with one page
  try {
    open = JSON.parse(readFileSync(file, 'utf8')).open ?? 1;
  } catch {
    /* no ledger yet */
  }
  try {
    writeFileSync(file, JSON.stringify({ open: Math.max(1, open + delta) }));
  } catch {
    /* without a ledger there is no page budget, which is acceptable */
  }
  return open;
}

const input = readStdin();
if (!input || MODE === 'off') process.exit(0);

// Tool names arrive as mcp__<server>__<tool>, and a plugin-provided server
// carries its own qualified id (plugin:<plugin>:<server>), so the server part
// can itself contain separators. Peel the tool off the end.
const raw = String(input.tool_name || '');
if (!raw.startsWith('mcp__')) process.exit(0);
const segments = raw.slice('mcp__'.length).split('__');
const tool = segments.at(-1);
const server = segments.slice(0, -1).join('__');
if (!server || !tool || !server.includes('chrome')) process.exit(0);

const args = input.tool_input || {};
const cwd = input.cwd;
// The uncapped server exists solely for pixel-exact work, which belongs on disk
// and in a diff script — never in the context window.
const isPixelServer = server.includes('pixel');
// The debug server is where forensics happen — many requests, large traces — so
// it holds a stricter line on writing bulk output to disk.
const isDebugServer = server.includes('debug');

if (args.includeSnapshot === true) {
  const { includeSnapshot, ...rest } = args;
  rewrite(rest,
    'Dropped includeSnapshot: it appends the whole accessibility tree (~550 tokens, and it stays ' +
    'in context for the rest of the session). To see what changed on the page, call ' +
    'evaluate_script and return just the values you care about — a class name, a text content, ' +
    'a bounding box.');
}

if (tool === 'take_snapshot' && !args.filePath) {
  const filePath = outputPath(cwd, 'snapshot', 'txt');
  rewrite({ ...args, filePath },
    `Snapshot written to ${filePath} instead of into the conversation, where it would have cost ` +
    '~550 tokens on every following request. Grep that file for the part you need. Usually the ' +
    'better move is evaluate_script returning just the value you are after.');
}

if (tool === 'take_screenshot' && !args.filePath && (args.fullPage === true || isPixelServer)) {
  const filePath = outputPath(cwd, 'screenshot', args.format === 'jpeg' ? 'jpg' : (args.format || 'png'));
  rewrite({ ...args, filePath },
    `Screenshot written to ${filePath} rather than into the conversation. ` +
    (isPixelServer
      ? 'Full-resolution images belong in a diff script, not in a context window — compare the files and report the numbers.'
      : 'Full-page images are the most expensive there are. If you need to look at the page yourself, take a plain viewport screenshot; if you need one element, pass uid.'));
}

if (tool === 'take_heapsnapshot' && !args.filePath) {
  const filePath = outputPath(cwd, 'heap', 'heapsnapshot');
  rewrite({ ...args, filePath },
    `Heap snapshot written to ${filePath}. Analyse it with get_heapsnapshot_summary, ` +
    'query_heapsnapshot_objects or compare_heapsnapshots — those take file paths and return only ' +
    'the slice you ask for. They need the chrome-debug server, which enables memory debugging.');
}

if (tool === 'lighthouse_audit' && !args.outputDirPath) {
  const outputDirPath = outputPath(cwd, 'lighthouse', 'd').replace(/\.d$/, '');
  rewrite({ ...args, outputDirPath },
    `Report written to ${outputDirPath}. Read the specific audits you are investigating from ` +
    'there; a full lighthouse report is far too large to read inline.');
}

if (tool === 'get_network_request' && isDebugServer && !args.responseFilePath) {
  const responseFilePath = outputPath(cwd, 'response', 'txt');
  rewrite({ ...args, responseFilePath },
    `Response body written to ${responseFilePath} — bodies average ~2500 tokens here and the ` +
    'large ones are far worse. Pull out what matters with jq or grep. The default chrome server ' +
    'still allows inline bodies for the occasional small response.');
}

if (tool === 'list_console_messages' && !args.types && !args.serviceWorkerId) {
  rewrite({ ...args, types: ['error', 'warn'], pageSize: args.pageSize ?? 50 },
    'Narrowed to errors and warnings, first 50. An unfiltered console dump is mostly noise. ' +
    'Call again with different types (or pageIdx) if you need more.');
}

if (tool === 'list_network_requests' && !args.resourceTypes && args.pageSize === undefined) {
  rewrite({ ...args, pageSize: 50 },
    'Capped the listing at 50 requests. Narrow it further with resourceTypes ' +
    '(e.g. ["fetch","xhr"]) or page through with pageIdx.');
}

// No rewrite can invent which page to close, so this one stays a refusal.
if (tool === 'new_page') {
  const openNow = adjustOpenPages(input.session_id, +1);
  if (openNow >= MAX_OPEN_PAGES) {
    adjustOpenPages(input.session_id, -1); // the call is refused, so do not count it
    refuse(
      `${openNow} pages are already open. Every navigation tool appends a list of all open tabs to ` +
      `its response, so each abandoned tab quietly taxes every later browser call. Close one you ` +
      `no longer need with close_page, or reuse the current page with navigate_page.`);
  }
} else if (tool === 'close_page') {
  adjustOpenPages(input.session_id, -1);
}

process.exit(0);
