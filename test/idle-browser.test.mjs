import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  responseText,
  listedPages,
  browserIsIdle,
  serverOf,
  parseProcessTable,
  findBrowser,
  run,
} from '../hooks/idle-browser.mjs';

const LAST_PAGE = 'The last open page cannot be closed. It is fine to keep it open.';

// --- responseText -----------------------------------------------------------

test('responseText joins the text of MCP content blocks', () => {
  const response = [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }];
  assert.match(responseText(response), /a[\s\S]*b/);
});

test('responseText reads an object that wraps the content array', () => {
  assert.match(responseText({ content: [{ type: 'text', text: '## Pages\n1: about:blank' }] }), /## Pages/);
});

test('responseText decodes a JSON-encoded response string', () => {
  const encoded = JSON.stringify([{ type: 'text', text: '## Pages\n1: about:blank [selected]' }]);
  assert.deepEqual(listedPages(responseText(encoded)), ['about:blank [selected]']);
});

// --- listedPages ------------------------------------------------------------

test('listedPages returns the entries of the Pages section only', () => {
  const text = 'Note: x\n## Pages\n1: about:blank\n2: Foo (https://a.test/) [selected]\n## Extension Pages\n3: ext';
  assert.deepEqual(listedPages(text), ['about:blank', 'Foo (https://a.test/) [selected]']);
});

test('listedPages is null without a Pages section', () => {
  assert.equal(listedPages('Successfully navigated.'), null);
});

// --- browserIsIdle ----------------------------------------------------------

test('a browser with nothing but about:blank left is idle', () => {
  assert.equal(browserIsIdle('## Pages\n1: about:blank [selected]'), true);
});

test('several blank tabs are still idle', () => {
  assert.equal(browserIsIdle('## Pages\n1: about:blank\n4: about:blank [selected]'), true);
});

test('a blank tab in an isolated context is idle', () => {
  assert.equal(browserIsIdle('## Pages\n2: about:blank [selected] isolatedContext=login'), true);
});

test('a page another agent still has open keeps the browser', () => {
  assert.equal(browserIsIdle('## Pages\n1: about:blank\n2: Studio (https://integ.test/) [selected]'), false);
});

test('a page titled about:blank is not a blank page', () => {
  assert.equal(browserIsIdle('## Pages\n1: about:blank (https://a.test/) [selected]'), false);
});

test('asking to close the only page left means the agent is done with it', () => {
  assert.equal(browserIsIdle(`${LAST_PAGE}\n## Pages\n1: Studio (https://integ.test/) [selected]`), true);
});

test('no page listing means no decision', () => {
  assert.equal(browserIsIdle(LAST_PAGE), false);
  assert.equal(browserIsIdle(''), false);
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
