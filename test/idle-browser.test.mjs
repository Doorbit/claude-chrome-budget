import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  responseText,
  listedPages,
  idleReason,
  serverOf,
  parseProcessTable,
  findBrowser,
  run,
  PS_ARGS,
  PS_TIMEOUT_MS,
} from '../hooks/idle-browser-core.mjs';

const LAST_PAGE = 'The last open page cannot be closed. It is fine to keep it open.';
const reason = (text, pageId) => idleReason(text, pageId)?.reason ?? null;

// --- responseText -----------------------------------------------------------

test('responseText joins the text of MCP content blocks', () => {
  const response = [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }];
  assert.match(responseText(response), /a[\s\S]*b/);
});

test('responseText reads an object that wraps the content array', () => {
  assert.match(responseText({ content: [{ type: 'text', text: '## Pages\n1: about:blank' }] }), /## Pages/);
});

test('responseText reads content and ignores structuredContent beside it', () => {
  const response = {
    content: [{ type: 'text', text: '## Pages\n1: about:blank [selected]' }],
    structuredContent: { pages: [{ id: 1, title: '7: Studio' }] },
  };
  assert.equal(reason(responseText(response), 1), 'blank');
});

test('responseText decodes a JSON-encoded response string', () => {
  const encoded = JSON.stringify([{ type: 'text', text: '## Pages\n1: about:blank [selected]' }]);
  assert.deepEqual(listedPages(responseText(encoded)), [{ id: 1, entry: 'about:blank [selected]' }]);
});

// --- listedPages ------------------------------------------------------------

test('listedPages returns the entries of the Pages section only', () => {
  const text = 'Note: x\n## Pages\n1: about:blank\n2: Foo (https://a.test/) [selected]\n## Extension Pages\n3: ext';
  assert.deepEqual(listedPages(text), [{ id: 1, entry: 'about:blank' }, { id: 2, entry: 'Foo (https://a.test/) [selected]' }]);
});

test('listedPages is null without a Pages section', () => {
  assert.equal(listedPages('Successfully navigated.'), null);
});

// --- idleReason -------------------------------------------------------------

test('a browser with nothing but about:blank left is idle', () => {
  assert.equal(reason('## Pages\n1: about:blank [selected]', 2), 'blank');
});

test('several blank tabs are still idle', () => {
  assert.equal(reason('## Pages\n1: about:blank\n4: about:blank [selected]', 2), 'blank');
});

test('a blank tab in an isolated context is idle', () => {
  assert.equal(reason('## Pages\n2: about:blank [selected] isolatedContext=login', 3), 'blank');
});

test('a blank tab in an isolated context whose name has a space is idle', () => {
  assert.equal(reason('## Pages\n2: about:blank [selected] isolatedContext=my login', 3), 'blank');
});

test('a page another agent still has open keeps the browser', () => {
  assert.equal(reason('## Pages\n1: about:blank\n2: Studio (https://integ.test/) [selected]', 3), null);
});

test('a page titled about:blank is not a blank page', () => {
  assert.equal(reason('## Pages\n1: about:blank (https://a.test/) [selected]', 2), null);
});

test('asking to close the only page left means the agent is done with it', () => {
  const idle = idleReason(`${LAST_PAGE}\n## Pages\n1: Studio (https://integ.test/) [selected]`, 1);
  assert.deepEqual(idle, { reason: 'last-page', page: 'Studio (https://integ.test/)' });
});

test("a refused close of some other page id does not cost the only page its browser", () => {
  assert.equal(reason(`${LAST_PAGE}\n## Pages\n1: Studio (https://integ.test/) [selected]`, 7), null);
  assert.equal(reason(`${LAST_PAGE}\n## Pages\n1: Studio (https://integ.test/) [selected]`, undefined), null);
});

test('the refusal never applies while two pages are listed', () => {
  for (const id of [1, 2]) {
    assert.equal(reason(`${LAST_PAGE}\n## Pages\n1: Docs (https://a.test/)\n2: Studio (https://integ.test/) [selected]`, id), null);
  }
});

test('no page listing means no decision', () => {
  assert.equal(reason(LAST_PAGE, 1), null);
  assert.equal(reason('', 1), null);
});

// --- serverOf ---------------------------------------------------------------

test('serverOf names the plugin server behind a tool', () => {
  assert.equal(serverOf('mcp__plugin_chrome-budget_chrome__close_page'), 'chrome');
  assert.equal(serverOf('mcp__plugin_chrome-budget_chrome-pixel__close_page'), 'chrome-pixel');
  assert.equal(serverOf('mcp__plugin_chrome-budget_chrome-debug__close_page'), 'chrome-debug');
});

test('serverOf ignores chrome servers this plugin does not own', () => {
  assert.equal(serverOf('mcp__chrome-devtools__close_page'), null);
  assert.equal(serverOf('mcp__plugin_other_chrome__close_page'), null);
  assert.equal(serverOf('Bash'), null);
});

// --- findBrowser ------------------------------------------------------------

const NPX = 'npm exec chrome-devtools-mcp@1.8.0';
const ARGS = {
  chrome: `${NPX} --isolated --no-usage-statistics --screenshotMaxWidth 1024 --screenshotMaxHeight 768`,
  'chrome-pixel': `${NPX} --isolated --no-usage-statistics`,
  'chrome-debug': `${NPX} --isolated --no-usage-statistics --memoryDebugging --screenshotMaxWidth 1024 --screenshotMaxHeight 768`,
};
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --user-data-dir=/tmp/p';
const HELPER = '/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper --type=renderer --remote-debugging-pipe';

/** Two Claude sessions (100 and 500), each with the three servers; Chrome launched where noted. */
function table({ ownChrome = ['chrome'], otherChrome = ['chrome'] } = {}) {
  const rows = [
    [1, 0, '/sbin/launchd'],
    [100, 1, '/opt/homebrew/bin/claude'],
    [101, 100, ARGS.chrome], [102, 101, 'chrome-devtools-mcp'],
    [111, 100, ARGS['chrome-pixel']], [112, 111, 'chrome-devtools-mcp'],
    [121, 100, ARGS['chrome-debug']], [122, 121, 'chrome-devtools-mcp'],
    [150, 100, '/bin/zsh -c node idle-browser.mjs'], [151, 150, 'node idle-browser.mjs'],
    [500, 1, '/opt/homebrew/bin/claude'],
    [501, 500, ARGS.chrome], [502, 501, 'chrome-devtools-mcp'],
  ];
  const own = { chrome: 102, 'chrome-pixel': 112, 'chrome-debug': 122 };
  for (const key of ownChrome) {
    const main = 1000 + own[key];
    rows.push([main, own[key], CHROME], [main + 1, main, HELPER]);
  }
  if (otherChrome.includes('chrome')) rows.push([2502, 502, CHROME]);
  return rows.map(([pid, ppid, args]) => ({ pid, ppid, args }));
}

test('parseProcessTable reads pid, ppid and the full argument string', () => {
  const rows = parseProcessTable('    1     0 /sbin/launchd\n  102   101 node a b  c\n');
  assert.deepEqual(rows, [{ pid: 1, ppid: 0, args: '/sbin/launchd' }, { pid: 102, ppid: 101, args: 'node a b  c' }]);
});

test("findBrowser finds this session's Chrome for the server, not another session's", () => {
  assert.equal(findBrowser(table(), 151, 'chrome'), 1102);
});

test('findBrowser tells the three servers apart', () => {
  const rows = table({ ownChrome: ['chrome', 'chrome-pixel', 'chrome-debug'] });
  assert.equal(findBrowser(rows, 151, 'chrome'), 1102);
  assert.equal(findBrowser(rows, 151, 'chrome-pixel'), 1112);
  assert.equal(findBrowser(rows, 151, 'chrome-debug'), 1122);
});

test('a Chrome helper outside the browser tree is not taken for a second browser', () => {
  const rows = table().concat([{ pid: 1190, ppid: 102, args: HELPER }]);
  assert.equal(findBrowser(rows, 151, 'chrome'), 1102);
});

test('findBrowser returns null when that server never launched Chrome', () => {
  assert.equal(findBrowser(table(), 151, 'chrome-pixel'), null);
});

test('findBrowser returns null outside a session that runs the servers', () => {
  const rows = table().concat([{ pid: 900, ppid: 1, args: 'bash' }, { pid: 901, ppid: 900, args: 'node idle-browser.mjs' }]);
  assert.equal(findBrowser(rows, 901, 'chrome'), null);
});

test('findBrowser refuses to guess between two matching servers', () => {
  const rows = table().concat([{ pid: 130, ppid: 100, args: ARGS.chrome }, { pid: 131, ppid: 130, args: 'chrome-devtools-mcp' },
    { pid: 1131, ppid: 131, args: CHROME }]);
  assert.equal(findBrowser(rows, 151, 'chrome'), null);
});

test('findBrowser refuses to guess between two browsers under one server', () => {
  const rows = table().concat([{ pid: 1105, ppid: 102, args: CHROME }]);
  assert.equal(findBrowser(rows, 151, 'chrome'), null);
});

test("a user's own chrome-devtools-mcp server is not taken for the pixel server", () => {
  const rows = table({ ownChrome: ['chrome-pixel'] }).concat([{ pid: 140, ppid: 100, args: 'npm exec chrome-devtools-mcp@latest' },
    { pid: 141, ppid: 100, args: '/bin/zsh -c ps -A | grep chrome-devtools-mcp' }]);
  assert.equal(findBrowser(rows, 151, 'chrome-pixel'), 1112);
});

test('findBrowser ends on a cycle in the process table', () => {
  const rows = [{ pid: 700, ppid: 701, args: 'a' }, { pid: 701, ppid: 700, args: 'b' }];
  assert.equal(findBrowser(rows, 700, 'chrome'), null);
});

test('the process table is read at full width, briefly', () => {
  // Claude Code sets COLUMNS for hooks; procps on Linux would then cut the
  // Chrome command line before --remote-debugging-pipe.
  assert.ok(PS_ARGS.includes('-ww'));
  assert.ok(PS_TIMEOUT_MS > 0 && PS_TIMEOUT_MS <= 3000);
});

// --- run --------------------------------------------------------------------

function hookInput(text, tool = 'mcp__plugin_chrome-budget_chrome__close_page') {
  return { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { pageId: 2 }, tool_response: [{ type: 'text', text }] };
}

function deps(overrides = {}) {
  const killed = [];
  return {
    killed,
    pid: 151,
    env: {},
    processTable: () => table().map((r) => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.args}`).join("\n"),
    kill: (pid) => killed.push(pid),
    ...overrides,
  };
}

test('run closes the idle browser and tells the model what happened', () => {
  const d = deps();
  const output = run(hookInput('## Pages\n1: about:blank [selected]'), d);
  assert.deepEqual(d.killed, [1102]);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /next browser call starts a fresh one/);
});

test('run leaves a browser alone while a page is still open', () => {
  const d = deps();
  assert.equal(run(hookInput('## Pages\n1: about:blank\n2: Studio (https://integ.test/) [selected]'), d), null);
  assert.deepEqual(d.killed, []);
});

test('run only reacts to close_page', () => {
  const d = deps();
  assert.equal(run(hookInput('## Pages\n1: about:blank [selected]', 'mcp__plugin_chrome-budget_chrome__navigate_page'), d), null);
  assert.deepEqual(d.killed, []);
});

test('run can be switched off through the plugin option', () => {
  for (const value of ['false', 'keep', '0', 'off']) {
    const d = deps({ env: { CLAUDE_PLUGIN_OPTION_CLOSE_IDLE_BROWSER: value } });
    assert.equal(run(hookInput('## Pages\n1: about:blank [selected]'), d), null);
    assert.deepEqual(d.killed, []);
  }
});

test('run stays quiet when the browser is already gone', () => {
  const d = deps({ kill: () => { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; } });
  assert.equal(run(hookInput('## Pages\n1: about:blank [selected]'), d), null);
});

test('run stays quiet when the process table cannot be read', () => {
  const d = deps({ processTable: () => { throw new Error('ps: not found'); } });
  assert.equal(run(hookInput('## Pages\n1: about:blank [selected]'), d), null);
  assert.deepEqual(d.killed, []);
});

test('run names the page that went with the browser when the agent closed the only one', () => {
  const d = deps();
  const output = run(hookInput(`${LAST_PAGE}\n## Pages\n2: Studio (https://integ.test/) [selected]`), d);
  assert.deepEqual(d.killed, [1102]);
  assert.match(output.hookSpecificOutput.additionalContext, /Studio \(https:\/\/integ\.test\/\) could not be closed on its own/);
});

// --- entry point --------------------------------------------------------------

const ENTRY = fileURLToPath(new URL('../hooks/idle-browser.mjs', import.meta.url));

test('the hook entry exits quietly on input it cannot read, also through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-browser-'));
  try {
    const linked = join(dir, 'idle-browser.mjs');
    symlinkSync(ENTRY, linked);
    for (const script of [ENTRY, linked]) {
      const result = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
