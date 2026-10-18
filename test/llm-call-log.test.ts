import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmCallLog, toMetadataOnly } from '../src/llm-call-log.js';
import { validateRecipe } from '../src/recipe.js';

const SECRET = 'the-actual-conversation-text';
const record = () => ({
  type: 'call',
  kind: 'complete',
  timestamp: '2026-10-18T00:00:00.000Z',
  durationMs: 12,
  requestSummary: { model: 'claude-x', maxTokens: 100, messages: 3, tools: 2, lastMessagePreview: SECRET },
  rawRequest: { messages: [{ role: 'user', content: SECRET }] },
  rawResponse: {
    id: 'msg_1', model: 'claude-x', stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
    content: [{ type: 'thinking', thinking: SECRET }, { type: 'text', text: SECRET }],
  },
  response: { stopReason: 'end_turn', usage: { inputTokens: 10 }, blocks: [{ type: 'text', chars: 28, text: SECRET }] },
});

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

describe('llm call log', () => {
  test('metadata_only drops every copy of the content, keeps usage and stop reason', () => {
    const out = toMetadataOnly(record());
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(out.rawRequest).toBeUndefined();
    expect((out.rawResponse as any).usage.cache_read_input_tokens).toBe(7);
    expect((out.rawResponse as any).stop_reason).toBe('end_turn');
    expect((out.rawResponse as any).contentBlocks).toEqual(['thinking', 'text']);
    expect((out.requestSummary as any).model).toBe('claude-x');
    expect((out.response as any).blocks).toEqual([{ type: 'text', chars: 28 }]);
  });

  test('stdout transport writes one tagged JSON line and no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmlog-'));
    const path = join(dir, 'llm-calls.x.jsonl');
    try {
      const log = new LlmCallLog({ path, provider: 'anthropic', transport: 'stdout', contentMode: 'metadata_only' });
      const lines = captureStdout(() => log.write(record()));
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.logger).toBe('llm-calls');
      expect(parsed.provider).toBe('anthropic');
      expect(parsed.rawResponse.usage.output_tokens).toBe(5);
      expect(lines[0]).not.toContain(SECRET);
      expect(() => readFileSync(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('default (file, content) behaves as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmlog-'));
    const path = join(dir, 'llm-calls.x.jsonl');
    try {
      const log = new LlmCallLog({ path, provider: 'x' });
      expect(log.transport).toBe('file');
      expect(log.keepsContent).toBe(true);
      const lines = captureStdout(() => log.write(record()));
      expect(lines).toHaveLength(0);
      const written = JSON.parse(readFileSync(path, 'utf8').trim());
      expect(written.rawResponse.content[1].text).toBe(SECRET);
      expect(written.logger).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recipe validation accepts logging.llmCalls and rejects bad values', () => {
    const base = { name: 'r', agent: { name: 'A' } };
    expect(() => validateRecipe({ ...base, logging: { llmCalls: { transport: 'stdout', contentMode: 'metadata_only' } } })).not.toThrow();
    expect(() => validateRecipe({ ...base, logging: { llmCalls: { transport: 'otlp' } } })).toThrow(/transport/);
    expect(() => validateRecipe({ ...base, logging: { llmCalls: { contentMode: 'full' } } })).toThrow(/contentMode/);
    expect(() => validateRecipe({ ...base, logging: { llmCals: {} } })).toThrow(/unknown field/);
  });
});
