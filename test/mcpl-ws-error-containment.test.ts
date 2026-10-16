import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

describe('MCPL websocket dial failure containment', () => {
  test('an HTTP upgrade rejection does not escape as an unhandled late error', async () => {
    const child = Bun.spawn(
      [process.execPath, resolve('test/fixtures/mcpl-ws-502-child.ts')],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('SURVIVED');
    expect(stderr).not.toContain('Unhandled error');
  });
});
