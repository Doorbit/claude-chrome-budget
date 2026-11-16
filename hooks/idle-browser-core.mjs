/**
 * PostToolUse hook: close a browser nobody is using any more.
 *
 * chrome-devtools-mcp refuses to close the last page, and the Chrome it
 * launched lives exactly as long as the server, which lives as long as the
 * Claude session. So an agent that tidies up after itself still leaves a
 * window on about:blank behind — 700–900 MB of RAM per instance, held for as
 * long as the session stays open, which with a terminal tab left alone can be
 * weeks.
 *
 * The server does not need that browser to stay. It checks `browser.connected`
 * before every call and launches a fresh one when the old one is gone, adding
 * "the browser was restarted" to that response. So once `close_page` leaves
 * nothing but blank tabs — or the agent asks to close the only page there is —
 * this hook ends that server's Chrome. What is lost is the state: the next
 * browser call starts from a clean profile and has to log in again.
 *
 * Only the browser of the server that answered, in this very session, is ever
 * touched. The hook finds it by walking up from its own process to the Claude
 * process that launched the plugin's servers, and down again to the Chrome
 * that server started. When any step is ambiguous it does nothing.
 *
 * Disabled with the plugin option close_idle_browser = false.
 *
 * This module only decides; hooks/idle-browser.mjs is the entry point that
 * reads stdin, runs ps and sends the signal. Keeping them apart means the
 * entry never has to work out whether it was imported or run, which breaks
 * as soon as the plugin path contains a symlink.
 */


const PLUGIN_SERVER_PREFIX = 'plugin_chrome-budget_';
const SERVERS = ['chrome', 'chrome-pixel', 'chrome-debug'];
// chrome-devtools-mcp's own wording (CLOSE_PAGE_ERROR), returned as text, not as an error.
const LAST_PAGE_REFUSAL = 'The last open page cannot be closed';
const BLANK = 'about:blank';
const DISABLED = new Set(['false', '0', 'off', 'no', 'keep']);
// -ww: Claude Code sets COLUMNS for hooks, and procps on Linux honours it even
// when piped, which would cut Chrome's command line before --remote-debugging-pipe.
export const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,args='];
export const PS_TIMEOUT_MS = 2000;

/** All text in a tool response, whatever shape the client hands it over in. */
export function responseText(response) {
  if (response == null) return '';
  if (typeof response === 'string') {
    const trimmed = response.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { return responseText(JSON.parse(trimmed)); } catch { /* plain text after all */ }
    }
    return response;
  }
  if (Array.isArray(response)) return response.map(responseText).join('\n');
  if (typeof response === 'object') {
    if (typeof response.text === 'string') return response.text;
    // structuredContent repeats the page list as data; its titles must not
    // turn into extra lines that look like page entries.
    if (Array.isArray(response.content)) return responseText(response.content);
    return Object.values(response).map(responseText).join('\n');
  }
  return '';
}

/** Entries of the `## Pages` section as { id, entry }; null when there is none. */
export function listedPages(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Pages');
  if (start === -1) return null;
  const pages = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const match = /^(\d+): (.*)$/.exec(line);
    if (match) pages.push({ id: Number(match[1]), entry: match[2] });
  }
  return pages;
}

/** The label the server prints for a page, stripped of selection and context markers. */
function pageLabel(entry) {
  return entry.replace(/ isolatedContext=.*$/, '').replace(/ \[selected\]$/, '');
}

/**
 * Why the browser behind this close_page response may go, or null if it may not:
 * { reason: 'blank' } when nothing but blank tabs is left, or
 * { reason: 'last-page', page } when the agent asked to close the only page there is.
 */
export function idleReason(text, requestedPageId) {
  const pages = listedPages(text);
  if (!pages || pages.length === 0) return null;
  if (pages.every(({ entry }) => pageLabel(entry) === BLANK)) return { reason: 'blank' };
  // The server refuses whenever a single page is left, before it looks at the
  // id — so the refusal alone does not say the agent meant that page. Only a
  // request for exactly that page does.
  if (pages.length === 1 && pages[0].id === requestedPageId && String(text).includes(LAST_PAGE_REFUSAL)) {
    return { reason: 'last-page', page: pageLabel(pages[0].entry) };
  }
  return null;
}

/** 'chrome' | 'chrome-pixel' | 'chrome-debug' for this plugin's tools, else null. */
export function serverOf(toolName) {
  const raw = String(toolName || '');
  if (!raw.startsWith('mcp__')) return null;
  const segments = raw.slice('mcp__'.length).split('__');
  const server = segments.slice(0, -1).join('__');
  if (!server.startsWith(PLUGIN_SERVER_PREFIX)) return null;
  const name = server.slice(PLUGIN_SERVER_PREFIX.length);
  return SERVERS.includes(name) ? name : null;
}

/** Rows of `ps -A -o pid=,ppid=,args=`. */
export function parseProcessTable(output) {
  const rows = [];
  for (const line of String(output).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3].trimStart() });
  }
  return rows;
}

/**
 * Which of the three servers a launcher command line belongs to. The servers
 * differ only in their flags (see .mcp.json), so the flags are what tells them
 * apart: only the debug server analyses memory, only the pixel server leaves
 * screenshots uncapped.
 */
function launchedServer(args) {
  // Pinned version and --isolated, as .mcp.json starts them: a user's own
  // chrome-devtools-mcp, or a shell command that merely mentions it, is not ours.
  if (!/chrome-devtools-mcp@\S+ --isolated\b/.test(args)) return null;
  if (args.includes('--memoryDebugging')) return 'chrome-debug';
  if (args.includes('--screenshotMaxWidth')) return 'chrome';
  return 'chrome-pixel';
}

const isChromeBrowser = (args) => args.includes('--remote-debugging-pipe') && !args.includes('--type=');

/**
 * The pid of the Chrome that `server` launched for the session this hook runs
 * in, or null. The session is the nearest ancestor that started chrome-devtools-mcp
 * servers itself; another session's browser is never a candidate.
 */
export function findBrowser(rows, startPid, server) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const kids = (pid) => children.get(pid) || [];

  let session = null;
  const seen = new Set();
  for (let pid = byPid.get(startPid)?.ppid; pid && !seen.has(pid); pid = byPid.get(pid)?.ppid) {
    seen.add(pid);
    if (kids(pid).some((child) => launchedServer(child.args))) { session = pid; break; }
  }
  if (session === null) return null;

  const launchers = kids(session).filter((child) => launchedServer(child.args) === server);
  if (launchers.length !== 1) return null;

  const browsers = [];
  const stack = [...kids(launchers[0].pid)];
  while (stack.length) {
    const row = stack.pop();
    if (isChromeBrowser(row.args)) { browsers.push(row.pid); continue; }
    stack.push(...kids(row.pid));
  }
  return browsers.length === 1 ? browsers[0] : null;
}

/** Decide and act. Returns the hook output, or null to stay silent. */
export function run(input, { pid, env, processTable, kill }) {
  if (!input || DISABLED.has(String(env.CLAUDE_PLUGIN_OPTION_CLOSE_IDLE_BROWSER ?? '').toLowerCase())) return null;
  const tool = String(input.tool_name || '');
  if (!tool.endsWith('__close_page')) return null;
  const server = serverOf(tool);
  if (!server) return null;
  const idle = idleReason(responseText(input.tool_response), Number(input.tool_input?.pageId));
  if (!idle) return null;

  let browser;
  try {
    browser = findBrowser(parseProcessTable(processTable()), pid, server);
  } catch {
    return null;
  }
  if (!browser) return null;
  try {
    kill(browser);
  } catch {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        (idle.reason === 'last-page'
          ? `${idle.page} could not be closed on its own, so the ${server} browser was closed with it. `
          : `No page was left open, so the ${server} browser was closed to free its memory. `) +
        'The next browser call starts a fresh one with a clean profile — logins and storage are gone.',
    },
  };
}

