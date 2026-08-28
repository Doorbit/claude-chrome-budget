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
 * fix. Refusing turned out to be worse twice over: it costs a round trip, and
 * a model that picks an unwritable path gets refused a second time by the
 * server and then abandons `filePath` altogether, landing back on the expensive
 * inline call. Nothing here refuses; it corrects and explains.
 *
 * Every rule that applies is applied. An earlier version emitted on the first
 * match, so a screenshot carrying a stray `includeSnapshot` had the flag
 * stripped and escaped the rule that would have written it to disk — the most
 * expensive shape slipping through the narrowest gap.
 *
 * Configuration comes from the plugin's userConfig, exposed as
 * CLAUDE_PLUGIN_OPTION_* environment variables.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const MODE = (process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT || 'correct').toLowerCase();
const OUT_DIR_NAME = '.chrome-budget';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
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
// The uncapped server exists solely for pixel-exact work, which belongs on disk
// and in a diff script — never in the context window.
const isPixelServer = server.includes('pixel');
// The debug server is where forensics happen — many requests, large traces — so
// it holds a stricter line on writing bulk output to disk.
const isDebugServer = server.includes('debug');

const next = { ...args };
const notes = [];
// Two separate questions: is there anything to say, and was the input actually
// changed. Advice-only rules must not send updatedInput back, or a rule that
// only wants to suggest something quietly resubmits the arguments as its own.
let mutated = false;
// In warn mode nothing is rewritten, so nothing may be described as done. An
// earlier version emitted the applied-text regardless, telling the model a file
// had been written that never was — and allocating the path created the output
// directory as a side effect of a mode documented as explaining only.
const applying = MODE !== 'warn';

/** Record a correction. Every rule runs; nothing short-circuits. */
function correct(apply, applied, advice) {
  if (applying) {
    apply(next);
    notes.push(applied);
    mutated = true;
  } else {
    notes.push(advice);
  }
}

/**
 * chrome-devtools-mcp writes only inside the workspace roots the client
 * negotiated. An agent's own scratchpad is outside them, which is how a model
 * that does the right thing still gets an "Access denied: not within any of the
 * configured workspace roots" — so pick the path here instead of describing it.
 */
function outputPath(name, extension) {
  if (!applying) return null;
  const cwd = input.cwd;
  const base = cwd && isAbsolute(cwd) ? cwd : tmpdir();
  const dir = join(base, OUT_DIR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
    // Keep the artefacts out of version control without asking anyone to.
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  } catch {
    return join(tmpdir(), `${name}-${Date.now()}${extension}`);
  }
  return join(dir, `${name}-${Date.now()}${extension}`);
}

if (args.includeSnapshot === true) {
  correct((a) => { delete a.includeSnapshot; },
    'Dropped includeSnapshot: it appends the whole accessibility tree (~550 tokens, and it stays ' +
    'in context for the rest of the session). To see what changed on the page, call ' +
    'evaluate_script and return just the values you care about.',
    'This call carries includeSnapshot, which appends the whole accessibility tree (~550 tokens, ' +
    're-sent every following request). Drop it and read what you need with evaluate_script.');
}

if (tool === 'take_snapshot' && !next.filePath) {
  // The server rewrites the extension to match the tool, so these have to be
  // the extensions it actually enforces — otherwise the path named here is not
  // the path the file ends up at, and the model greps something that is not there.
  const filePath = outputPath('snapshot', '.txt');
  correct((a) => { a.filePath = filePath; },
    `Snapshot written to ${filePath} instead of into the conversation, where it would have cost ` +
    '~550 tokens on every following request. Grep that file for the part you need. Usually the ' +
    'better move is evaluate_script returning just the value you are after.',
    'A snapshot without filePath costs ~550 tokens on every following request. Pass filePath and ' +
    'grep the file, or better, ask evaluate_script for the one value you need.');
}

if (tool === 'take_screenshot' && !next.filePath && (next.fullPage === true || isPixelServer)) {
  const extension = next.format === 'jpeg' ? '.jpeg' : next.format === 'webp' ? '.webp' : '.png';
  const filePath = outputPath('screenshot', extension);
  const why = isPixelServer
    ? 'Full-resolution images belong in a diff script, not in a context window — compare the files and report the numbers.'
    : 'Full-page images are the most expensive there are. If you need to look at the page yourself, take a plain viewport screenshot; if you need one element, pass uid.';
  correct((a) => { a.filePath = filePath; },
    `Screenshot written to ${filePath} rather than into the conversation. ${why}`,
    `This screenshot would go into the conversation at full cost. ${why}`);
}

if (tool === 'lighthouse_audit' && !next.outputDirPath) {
  const outputDirPath = outputPath('lighthouse', '');
  correct((a) => { a.outputDirPath = outputDirPath; },
    `Report written to ${outputDirPath}. Read the specific audits you are investigating from ` +
    'there; a full lighthouse report is far too large to read inline.',
    'A lighthouse report is far too large to read inline. Pass outputDirPath and read the ' +
    'specific audits you are investigating.');
}

if (tool === 'get_network_request' && isDebugServer && !next.responseFilePath) {
  const responseFilePath = outputPath('response', '.network-response');
  correct((a) => { a.responseFilePath = responseFilePath; },
    `Response body written to ${responseFilePath} — bodies average ~2500 tokens here and the ` +
    'large ones are far worse. Pull out what matters with jq or grep. The default chrome server ' +
    'still allows inline bodies for the occasional small response.',
    'Response bodies average ~2500 tokens on this server. Pass responseFilePath and pull out ' +
    'what matters with jq or grep.');
}

if (tool === 'list_console_messages' && !next.types && !next.serviceWorkerId) {
  // types only. The server already pages at 20 by default, so injecting a
  // pageSize of 50 made this call two and a half times larger than doing
  // nothing — measured at 288 tokens against 31 for a types filter alone.
  // A correction that costs more than the thing it corrects is worse than none.
  correct((a) => { a.types = ['error', 'warn']; },
    'Narrowed to errors and warnings. An unfiltered console dump is mostly noise. ' +
    'Call again with different types, or pageSize/pageIdx, if you need more.',
    'An unfiltered console dump is mostly noise. Pass types, e.g. ["error"].');
}

if (tool === 'list_network_requests' && !next.resourceTypes && next.pageSize === undefined) {
  // Advice only, no rewrite: the guard cannot guess which resource types the
  // task cares about, and the server's own default page size of 20 is already
  // tighter than anything worth injecting here.
  notes.push(
    'This request listing is unfiltered. resourceTypes (e.g. ["fetch","xhr"]) usually answers ' +
    'the question in a fraction of the output; pageIdx pages through the rest.');
}

if (!notes.length) process.exit(0);

// `updatedInput` is honoured on its own, without a permissionDecision —
// verified in a live session against Claude Code 2.1.238. Deliberately not
// paired with `permissionDecision: 'allow'`: a hook that exists to count tokens
// has no business granting a permission the user might otherwise be asked
// about. If a future version stops honouring the bare field, the corrections
// silently stop applying, so re-check this when upgrading.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    ...(mutated ? { updatedInput: next } : {}),
    additionalContext: notes.join(' '),
  },
}));
