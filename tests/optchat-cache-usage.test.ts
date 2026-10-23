import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, emptyUsage } from '../vendor/pi-optchat/src/usage.ts';

function entry(id: string) {
  return { id, type: 'message', timestamp: '2026-10-23T12:00:00Z', message: {
    role: 'assistant', timestamp: Date.parse('2026-10-23T12:00:00Z'), provider: 'anthropic', model: 'opus', usage: emptyUsage(),
  } } as any;
}
test('records actual request policy without labeling historical usage or duplicating recovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'optchat-policy-'));
  const previous = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = 'long';
  try {
    const ledger = new UsageLedger(directory);
    const entries = [entry('historical')];
    ledger.request(entries, 'session', 'connected', 'child');
    entries.push(entry('connected'));
    ledger.request(entries, 'session', 'delegated', 'child');
    entries.push(entry('delegated'));
    ledger.backfill(entries, 'session', 'subagent', 'child');
    assert.equal(ledger.entries.length, 3);
    assert.equal(ledger.entries[0].requestedRetention, undefined);
    assert.equal(ledger.entries[1].workload, 'connected');
    assert.equal(ledger.entries[1].requestedRetention, 'long');
    assert.equal(ledger.entries[2].workload, 'delegated');
    assert.equal(ledger.entries[2].requestedRetention, 'short');
    assert.equal(ledger.entries[2].cachePolicy, 'workload-v1');
    ledger.backfill(entries, 'session', 'subagent', 'child');
    assert.equal(ledger.entries.length, 3);
    const reopened = new UsageLedger(directory);
    reopened.backfill(entries, 'session', 'subagent', 'child');
    assert.deepEqual(reopened.entries, ledger.entries);
    // Recovery after a crash must not apply the new process policy to an old response.
    entries.push(entry('crash-recovered'));
    reopened.backfill(entries, 'session', 'subagent', 'child');
    assert.equal(reopened.entries[3].requestedRetention, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
