import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const servers = JSON.parse(readFileSync(new URL('.mcp.json', root), 'utf8')).mcpServers;
const hooks = JSON.parse(readFileSync(new URL('hooks/hooks.json', root), 'utf8')).hooks;

test('every server opts out of usage statistics, which also spares its watchdog process', () => {
  for (const [name, server] of Object.entries(servers)) {
    assert.ok(server.args.includes('--no-usage-statistics'), `${name} still starts the telemetry watchdog`);
  }
});

test('the idle-browser hook runs after close_page on every plugin server', () => {
  const entry = hooks.PostToolUse?.find((h) => h.hooks.some((c) => c.command.includes('idle-browser.mjs')));
  assert.ok(entry, 'no PostToolUse hook runs idle-browser.mjs');
  const matcher = new RegExp(`^(?:${entry.matcher})$`);
  for (const name of Object.keys(servers)) {
    assert.ok(matcher.test(`mcp__plugin_chrome-budget_${name}__close_page`), `matcher misses ${name}`);
  }
  assert.equal(matcher.test('mcp__plugin_chrome-budget_chrome__navigate_page'), false);
});

test('the idle-browser hook cannot hold up a turn for long', () => {
  const entry = hooks.PostToolUse.find((h) => h.hooks.some((c) => c.command.includes('idle-browser.mjs')));
  const command = entry.hooks.find((c) => c.command.includes('idle-browser.mjs'));
  assert.ok(Number.isFinite(command.timeout) && command.timeout <= 10, 'no short timeout on the hook');
});

test('the idle-browser hook recognises each server exactly as .mcp.json launches it', async () => {
  const { launchedServer } = await import('../hooks/idle-browser-core.mjs');
  for (const [name, server] of Object.entries(servers)) {
    const args = server.args.filter((a) => a !== '-y').map((a) => a.replace(/\$\{user_config\.[^}]+\}/, '1024'));
    assert.equal(launchedServer(`npm exec ${args.join(' ')}`), name, `${name} is not recognised`);
  }
});

test('every server runs headless by default, so no browser window takes the focus', () => {
  const config = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8')).userConfig;
  assert.equal(config.headless?.type, 'boolean');
  assert.equal(config.headless.default, true);
  for (const [name, server] of Object.entries(servers)) {
    assert.ok(server.args.includes('--headless=${user_config.headless}'), `${name} ignores the headless option`);
    const at = server.args.indexOf('--viewport');
    assert.ok(at > 0 && /^\d+x\d+$/.test(server.args[at + 1]), `${name} has no fixed viewport`);
  }
});
