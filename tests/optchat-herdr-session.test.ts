import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectedSessionAdapter, trustedTranscript } from '../vendor/pi-optchat/src/herdr-session.ts';

test('Herdr transcript references stay inside the connected profile, including symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'optchat-herdr-'));
  try {
    const runs = join(root, 'runs');
    mkdirSync(runs);
    const transcript = join(runs, 'connected.jsonl');
    writeFileSync(transcript, '{}\n');
    const outside = join(root, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    symlinkSync(outside, join(runs, 'escape.jsonl'));
    assert.equal(trustedTranscript(transcript, runs), transcript);
    assert.equal(trustedTranscript(join(runs, 'next.jsonl'), runs), join(runs, 'next.jsonl'));
    for (const path of [outside, join(runs, 'escape.jsonl'), 'relative.jsonl', join(runs, 'bad.txt'), runs]) {
      assert.equal(trustedTranscript(path, runs), null);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Herdr adapter reports connected transcript through the managed reporter and resets on session start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'optchat-herdr-'));
  try {
    const transcript = join(root, 'connected.jsonl');
    writeFileSync(transcript, '{}\n');
    const handlers = new Map<string, Function>();
    const events = new Map<string, Function>();
    const reports: string[] = [];
    const pi = { on: (event: string, handler: Function) => handlers.set(event, handler), events: { on: (event: string, handler: Function) => events.set(event, handler) } };
    connectedSessionAdapter(wrapped => wrapped.on('session_start', (_event: unknown, ctx: any) => reports.push(ctx.sessionManager.getSessionFile())), pi, root);
    const ctx = { mode: 'tui', sessionManager: { getSessionFile: () => 'original.jsonl' } };
    await handlers.get('session_start')!({}, ctx);
    await events.get('optchat:transcript')!({ path: transcript });
    await events.get('optchat:transcript')!({ path: '/tmp/untrusted.jsonl' });
    await handlers.get('session_start')!({}, ctx);
    assert.deepEqual(reports, ['original.jsonl', transcript, 'original.jsonl']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
