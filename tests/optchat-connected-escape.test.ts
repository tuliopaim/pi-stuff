import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { Editor, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, TuiMainScreen } from '@earendil-works/pi-tui';
import tripleEscape from '../agent/extensions/triple-escape.ts';
import { openConnectedWindow } from '../vendor/pi-optchat/src/connected-window.ts';
import { profilePath, profileSocket } from '../vendor/pi-optchat/src/profiles.ts';

// Real connected-window terminal listener + real editor + local socket owner.
// The owner records protocol requests only. No model, credentials, or live profiles.
async function fixture(guarded = true) {
  initTheme('dark');
  const oldHome = process.env.OPTCHAT_HOME;
  const home = mkdtempSync('/tmp/pi-esc-');
  process.env.OPTCHAT_HOME = home;
  mkdirSync(profilePath('test'), { recursive: true });
  const actions: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        actions.push(request.action);
        if (request.action === 'start') {
          socket.write(JSON.stringify({ kind: 'event', name: 'started', text: 'test-agent' }) + '\n');
          socket.write(JSON.stringify({ kind: 'event', name: 'status', text: '', live: {
            state: 'running', model: 'offline', tools: [], queued: [], agents: 0,
          } }) + '\n');
        }
        socket.write(JSON.stringify({ kind: 'reply', id: request.id }) + '\n');
      }
    });
  });
  server.listen(profileSocket(profilePath('test'), 'windows'));
  await once(server, 'listening');
  const terminal = { start() {}, stop() {}, async drainInput() {}, write() {},
    columns: 100, rows: 30, kittyProtocolActive: false,
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = new TuiMainScreen(terminal as any);
  const theme = { fg: (_: string, text: string) => text };
  let factory: any, start: any, input: any, widget: any;
  let editor: any;
  const ctx: any = { cwd: home, mode: 'tui', shutdown() {}, ui: {
    setStatus() {}, notify() {}, setWorkingMessage() {}, setTitle() {},
    setEditorComponent(next: any) { factory = next; },
    onTerminalInput(handler: any) { input = handler; return () => { input = undefined; }; },
    getEditorText: () => editor.getText(), setEditorText: (text: string) => editor.setText(text),
    setWidget(_key: string, next: any) { widget?.dispose?.(); widget = next?.(tui, theme); },
  } };
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS,
    'app.interrupt': { defaultKeys: 'escape' }, 'app.message.dequeue': { defaultKeys: 'alt+up' } });
  setKeybindings(keys);
  if (guarded) {
    tripleEscape({ on: (_: string, handler: any) => { start = handler; }, events: { emit() {} } } as any);
    start({}, ctx);
    editor = factory(tui, {}, keys);
  } else {
    editor = new Editor(tui, {} as any);
  }
  tui.setFocus(editor);
  const window = await openConnectedWindow({ sendMessage() {}, events: { emit() {} } } as any, ctx, 'test');
  await window.submit('offline task');
  return {
    actions, editor, tui,
    async press(data: string) {
      const result = input(data);
      if (!result?.consume) editor.handleInput(result?.data ?? data);
      // A round trip on the same socket is a deterministic barrier, not a sleep.
      await window.tell('barrier');
    },
    async close() {
      window.close(); widget?.dispose?.();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('connected-window input must not bypass triple-Esc before sending an agent interrupt', async () => {
  const f = await fixture();
  try {
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 0, 'one Esc must not cancel the connected agent');
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 0);
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 1);
  } finally { await f.close(); }
});

test('typing resets the connected-window triple-Esc sequence', async () => {
  const f = await fixture();
  try {
    await f.press('\x1b'); await f.press('\x1b');
    await f.press('a');
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 0);
    await f.press('\x1b'); await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 1);
  } finally { await f.close(); }
});

test('a pause longer than one second resets connected-window presses', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture();
  try {
    await f.press('\x1b');
    now = 2_001;
    await f.press('\x1b');
    now = 2_100;
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 0);
    now = 2_200;
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 1);
  } finally { await f.close(); }
});

test('autocomplete Esc dismisses without forwarding an interrupt and resets the gate', async (t) => {
  const f = await fixture();
  try {
    await f.press('\x1b'); await f.press('\x1b');
    const showing = t.mock.method(f.editor, 'isShowingAutocomplete', () => true);
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 0);
    showing.mock.restore();
    await f.press('\x1b'); await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 0);
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 1);
  } finally { await f.close(); }
});

test('ordinary editors keep upstream single-Esc connected-window behavior', async () => {
  const f = await fixture(false);
  try {
    await f.press('\x1b');
    assert.equal(f.actions.filter(a => a === 'interrupt').length, 1);
  } finally { await f.close(); }
});
