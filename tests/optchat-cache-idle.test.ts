// Offline mechanism tests, not an Anthropic emulator or a reproduction of the historical wire requests.
// Models prefix identity, explicit writes, 20-position lookup, TTL and read refresh.
// No tokenization, minimum cache size, images, tool-run position grouping, or server eviction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cachePayload } from '../vendor/pi-optchat/src/cache.ts';
import { Memory } from '../vendor/pi-optchat/src/memory.ts';
import type { Saved, Store } from '../vendor/pi-optchat/src/store.ts';

type Block = { type?: string; text?: string; cache_control?: { type: string; ttl?: string }; [key: string]: unknown };
type Body = { tools: Block[]; system: Block[]; messages: { role: string; content: Block[] }[] };
class PrefixCache {
  now = 0;
  entries = new Map<string, { expires: number; ttl: number }>();
  request(body: Body) {
    const blocks = [...body.tools.map(block => ({ section: 'tools', ...block })),
      ...body.system.map(block => ({ section: 'system', ...block })),
      ...body.messages.flatMap(m => m.content.map(block => ({ role: m.role, ...block })))];
    const marks: number[] = [], keys: string[] = [], ends: number[] = [];
    for (const [i, { cache_control, ...block }] of blocks.entries()) {
      const json = JSON.stringify(block);
      keys.push(createHash('sha256').update((keys.at(-1) ?? '') + json).digest('hex'));
      ends.push((ends.at(-1) ?? 0) + Buffer.byteLength(json));
      if (cache_control) marks.push(i);
    }
    assert.ok(marks.length <= 4);
    let hit = -1;
    for (const mark of marks) for (let i = mark; i >= 0 && i > mark - 20; i--) {
      if ((this.entries.get(keys[i])?.expires ?? -1) > this.now) { hit = Math.max(hit, i); break; }
    }
    if (hit >= 0) {
      const entry = this.entries.get(keys[hit])!;
      entry.expires = this.now + entry.ttl;
    }
    for (const mark of marks) if (mark > hit) {
      const ttl = blocks[mark].cache_control?.ttl === '1h' ? 3_600_000 : 300_000;
      this.entries.set(keys[mark], { ttl, expires: this.now + ttl });
    }
    return { readBytes: hit < 0 ? 0 : ends[hit], totalBytes: ends.at(-1) ?? 0, marks: marks.length };
  }
}
const view = (lines = 180) => '<chat>\n' + Array.from({ length: lines }, (_, i) => `${i}+1|user: synthetic memory ${i}\n`).join('') + '</chat>';
function body(text = view(), retention = 'long'): Body {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('OPTCHAT_CACHE_')) delete process.env[key];
    process.env.PI_CACHE_RETENTION = retention;
    return cachePayload({ tools: [{ name: 'zoom', description: 'stable synthetic tool', cache_control: { type: 'ephemeral' } }],
      system: [{ type: 'text', text: 'stable synthetic system', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'text', text: 'synthetic task' }] }],
    }) as Body;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('unchanged 1h payload survives 11 minutes; unchanged 5m payload does not', () => {
  for (const retention of ['long', 'short']) {
    const cache = new PrefixCache();
    assert.equal(cache.request(body(view(), retention)).readBytes, 0);
    cache.now += 11 * 60_000;
    const result = cache.request(body(view(), retention));
    assert.equal(result.readBytes > 0, retention === 'long');
  }
});
test('1h read refreshes expiry; an unread entry expires after an hour', () => {
  const cache = new PrefixCache();
  cache.request(body());
  cache.now = 59 * 60_000;
  assert.ok(cache.request(body()).readBytes > 0);
  cache.now = 70 * 60_000;
  assert.ok(cache.request(body()).readBytes > 0);
  cache.now += 61 * 60_000;
  assert.equal(cache.request(body()).readBytes, 0);
});
test('rewrite of first view block loses all reads within 1h despite identical system and tools', () => {
  const cache = new PrefixCache();
  cache.request(body());
  cache.now += 11 * 60_000;
  assert.equal(cache.request(body(view().replace('synthetic memory 0', 'rewritten memory 0'))).readBytes, 0);
});
test('stable view with new task reuses prefix, but changing system invalidates it', () => {
  const cache = new PrefixCache();
  cache.request(body());
  cache.now += 11 * 60_000;
  const next = body();
  next.messages[0].content.at(-1)!.text = 'different task';
  assert.ok(cache.request(next).readBytes > 0);
  next.system[0].text = 'changed system';
  assert.equal(cache.request(next).readBytes, 0);
});
test('view growth past the 60-block lookup coverage can miss without any prefix rewrite', () => {
  for (const extra of [4, 80, 160, 236, 260]) {
    const cache = new PrefixCache();
    cache.request(body());
    cache.now += 11 * 60_000;
    assert.equal(cache.request(body(view(180 + extra))).readBytes > 0, extra < 240, `extra lines: ${extra}`);
  }
});
test('real Memory compaction can produce a full 1h miss without waiting for expiry', async () => {
  const saved: Saved = { entries: [], tree: [] };
  const store: Store = { load: () => structuredClone(saved), append: e => { saved.entries.push(e); },
    appendNode: n => { saved.tree.push(n); }, saveView: v => { saved.view = v; },
    putImage: () => undefined, image: () => undefined };
  const memory = new Memory({ directory: '/synthetic', store, saved: structuredClone(saved) },
    async ({ part }) => `summary of ${part.i} at level ${part.l}`, () => {}, 1600);
  try {
    for (let i = 0; i < 8; i++) memory.append('user', `entry ${i}: ${'x'.repeat(100)}`);
    await memory.settle(undefined, 'tree');
    const before = memory.render();
    const cache = new PrefixCache();
    cache.request(body(before));
    for (let i = 8; i < 24; i++) memory.append('user', `entry ${i}: ${'x'.repeat(100)}`);
    await memory.settle(undefined, 'tree');
    const after = memory.render();
    assert.notEqual(before.split('\n')[1], after.split('\n')[1], 'compaction changed the oldest rendered line');
    cache.now += 11 * 60_000;
    assert.equal(cache.request(body(after)).readBytes, 0);
    assert.ok(cache.request(body(after)).readBytes > 0, 'immediate follow-up reuses the rewritten view');
  } finally { await memory.close(); }
});

test('experimental system fallback preserves only early prefix on a view rewrite, within four marks', () => {
  // Experiment only: replace the oldest of three view marks, not a live policy change.
  const fallback = (text: string) => {
    const payload = body(text);
    const marked = payload.messages.flatMap(m => m.content).filter(b => b.cache_control);
    assert.equal(marked.length, 4);
    delete marked[0].cache_control;
    payload.system[0].cache_control = { type: 'ephemeral', ttl: '1h' };
    return payload;
  };
  const cache = new PrefixCache();
  cache.request(fallback(view()));
  cache.now += 11 * 60_000;
  const result = cache.request(fallback(view().replace('synthetic memory 0', 'rewritten memory 0')));
  assert.equal(result.marks, 4);
  assert.ok(result.readBytes > 0);
  assert.ok(result.readBytes < result.totalBytes / 10, 'only system/tools survive, not rewritten memory');
});
