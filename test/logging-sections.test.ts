import { describe, expect, test } from 'bun:test';
import { setupMcplStderrLog } from '../src/logging/mcpl.js';
import { setupHeadlessLog } from '../src/logging/headless.js';
import { validateRecipe } from '../src/recipe.js';

function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join('').split('\n').filter(Boolean);
}

describe('logging sections', () => {
  test('mcpl stdout transport: one JSON line per trace, with server and event', () => {
    let handler: ((e: unknown) => void) | undefined;
    const app = { framework: { onTrace: (h: (e: unknown) => void) => { handler = h; } } } as never;
    setupMcplStderrLog(app, { transport: 'stdout' });
    const lines = captureStdout(() => {
      handler!({ type: 'mcpl:server-stderr', serverId: 'discord', timestamp: 0, line: 'hello' });
      handler!({ type: 'mcpl:server-closed', serverId: 'discord', timestamp: 0, code: 1, signal: null });
      handler!({ type: 'inference:speech', timestamp: 0 });
    });
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    expect(a).toEqual({ logger: 'mcpl', ts: '1970-01-01T00:00:00.000Z', server: 'discord', event: 'mcpl:server-stderr', line: 'hello' });
    expect(JSON.parse(lines[1]!).line).toContain('connection closed');
  });

  test('headless stdout transport: JSON lines, no redirect', async () => {
    const before = process.stdout.write;
    const h = await setupHeadlessLog({ transport: 'stdout' });
    expect(process.stdout.write).toBe(before);
    const lines = captureStdout(() => h.log('headless start pid=1'));
    const j = JSON.parse(lines[0]!);
    expect(j.logger).toBe('headless');
    expect(j.msg).toBe('headless start pid=1');
    expect(typeof j.ts).toBe('string');
  });

  test('recipe validation for logging sections', () => {
    const base = { name: 'r', agent: { name: 'A' } };
    const ok = { llmCalls: { transport: 'stdout', contentMode: 'metadata_only' }, mcpl: { transport: 'stdout' }, headless: { transport: 'file', dir: '/var/tmp' } };
    expect(() => validateRecipe({ ...base, logging: ok })).not.toThrow();
    expect(() => validateRecipe({ ...base, logging: { mcpl: { transport: 'journald' } } })).toThrow(/mcpl.transport/);
    expect(() => validateRecipe({ ...base, logging: { headless: { dir: 'relative/path' } } })).toThrow(/headless.dir/);
    expect(() => validateRecipe({ ...base, logging: { failures: {} } })).toThrow(/unknown field/);
  });
});
