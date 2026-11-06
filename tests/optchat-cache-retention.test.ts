import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { cachePayload, cacheRetention } from '../vendor/pi-optchat/src/cache.ts';

function payload() {
  return {
    cache_control: { type: 'ephemeral' },
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'tool', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [
      { type: 'text', text: '<chat>\n' + Array.from({ length: 180 }, (_, i) => `${i}+1|line\n`).join('') + '</chat>' },
      { type: 'text', text: 'current task', cache_control: { type: 'ephemeral' } },
    ] }],
  };
}
function marks(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(marks);
  const record = value as Record<string, unknown>;
  return [...(record.cache_control ? [record.cache_control as Record<string, unknown>] : []),
    ...Object.entries(record).filter(([key]) => key !== 'cache_control').flatMap(([, child]) => marks(child))];
}
for (const retention of ['long', 'short', 'none'] as const) {
  for (const end of [true, false]) {
    test(`${retention} retention on ${end ? 'main/subagent' : 'compactor'} markers`, () => {
      const previous = process.env.PI_CACHE_RETENTION;
      process.env.PI_CACHE_RETENTION = retention;
      try {
        assert.equal(cacheRetention(), retention);
        const result = cachePayload(payload(), { end });
        const controls = marks(result);
        assert.equal(controls.length, retention === 'none' ? 0 : end ? 4 : 3);
        for (const control of controls) assert.deepEqual(control,
          retention === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
        if (!end && retention !== 'none') {
          assert.equal((result as ReturnType<typeof payload>).messages[0].content.at(-1)?.text, 'current task');
          assert.equal('cache_control' in (result as ReturnType<typeof payload>).messages[0].content.at(-1)!, false);
        }
      } finally {
        if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
        else process.env.PI_CACHE_RETENTION = previous;
      }
    });
  }
}
test('compactor passes the same retention into the provider options', () => {
  const source = readFileSync(new URL('../vendor/pi-optchat/src/compactor.ts', import.meta.url), 'utf8');
  assert.match(source, /cacheRetention: cacheRetention\(input.historical/);
  assert.doesNotMatch(source, /cacheRetention: 'short'/);
});

for (const workload of ['main', 'connected', 'delegated', 'compactor', 'import'] as const) {
  test(`${workload} policy defaults and independent overrides`, () => {
    const saved = { ...process.env };
    const key = `OPTCHAT_CACHE_${workload.toUpperCase()}`;
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith('OPTCHAT_CACHE_')) delete process.env[k];
      process.env.PI_CACHE_RETENTION = 'long';
      const expected = workload === 'main' || workload === 'connected' ? 'long' : 'short';
      assert.equal(cacheRetention(workload), expected);
      for (const retention of [expected, 'long', 'short', 'none'] as const) {
        process.env[key] = retention;
        assert.equal(cacheRetention(workload), retention);
        const controls = marks(cachePayload(payload(), { workload, end: workload !== 'compactor' && workload !== 'import' }));
        assert.equal(controls.length, retention === 'none' ? 0 : workload === 'compactor' || workload === 'import' ? 3 : 4);
        for (const control of controls) assert.deepEqual(control, retention === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
      }
      process.env[key] = 'invalid';
      assert.throws(() => cacheRetention(workload), /must be/);
      process.env[key] = 'long';
      process.env.PI_CACHE_RETENTION = 'none';
      assert.equal(cacheRetention(workload), 'none');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
}

test('a connected window handoff keeps connected retention, overrides and master off', async () => {
  const { windowHandoff } = await import('../vendor/pi-optchat/src/prompts.ts');
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('OPTCHAT_CACHE_')) delete process.env[key];
    process.env.PI_CACHE_RETENTION = 'long';
    for (const retention of ['long', 'short', 'none'] as const) {
      process.env.OPTCHAT_CACHE_CONNECTED = retention;
      const body = payload();
      body.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Work completed' }] });
      body.messages.push({ role: 'user', content: [{ type: 'text', text: windowHandoff('complete', { undelivered: [], unread: [], stopped: [] }) }] });
      const controls = marks(cachePayload(body, { workload: 'connected' }));
      assert.equal(controls.length, retention === 'none' ? 0 : 4);
      for (const control of controls) assert.deepEqual(control, retention === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
      process.env.PI_CACHE_RETENTION = 'none';
      assert.equal(marks(cachePayload(payload(), { workload: 'connected' })).length, 0);
      process.env.PI_CACHE_RETENTION = 'long';
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('handoff compactor fallback uses compactor retention, not connected retention', async () => {
  const { createHandoffSummarizer } = await import('../vendor/pi-optchat/src/handoff.ts');
  const saved = { ...process.env };
  const observed: string[] = [];
  const registry = {
    find: () => ({ contextWindow: 100_000, maxTokens: 1000, reasoning: false }),
    streamSimple: (_model: unknown, _context: unknown, options: { cacheRetention: string }) => {
      observed.push(options.cacheRetention);
      return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'Handoff' }] }) };
    },
  };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('OPTCHAT_CACHE_')) delete process.env[key];
    process.env.PI_CACHE_RETENTION = 'long';
    const summarize = createHandoffSummarizer(registry as any, () => ({ provider: 'synthetic', model: 'test', thinking: 'off' }), () => {});
    const run = { id: 'test', task: 'Task', guidance: [] } as any;
    await summarize(run, []);
    process.env.OPTCHAT_CACHE_COMPACTOR = 'long';
    await summarize(run, []);
    process.env.PI_CACHE_RETENTION = 'none';
    await summarize(run, []);
    assert.deepEqual(observed, ['short', 'long', 'none']);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
