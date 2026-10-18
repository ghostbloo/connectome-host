/**
 * Where provider-call records go, and how much of each call they keep.
 *
 *   transport   'file'   — append JSONL to `llm-calls.<iso>.jsonl` in the data
 *                          dir (the original behaviour).
 *               'stdout' — one JSON line per call on process.stdout, tagged
 *                          `logger: 'llm-calls'` and the recipe `provider`, for a log collector to pick
 *                          up. Written with process.stdout.write, not
 *                          console.log: headless mode captures stdout into
 *                          headless.log by replacing process.stdout.write,
 *                          and under bun console.log bypasses that. Nothing is written next to the store.
 *   contentMode 'content'       — records as before: response bodies, and
 *                                 request bodies on refusals/errors (all of
 *                                 them with LLM_CALLS_FULL_PAYLOADS=1).
 *               'metadata_only' — no conversation content at all: model,
 *                                 sizes, usage, stop reason, timing, error
 *                                 text. LLM_CALLS_FULL_PAYLOADS is ignored.
 *
 * Recipe: `logging.llmCalls = { transport, contentMode }`; default
 * `{ transport: 'file', contentMode: 'content' }`.
 */
import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';

export type LlmCallTransport = 'file' | 'stdout';
export type LlmCallContentMode = 'content' | 'metadata_only';

export interface LlmCallLogConfig {
  transport: LlmCallTransport;
  contentMode: LlmCallContentMode;
}

export const DEFAULT_LLM_CALL_LOG_CONFIG: LlmCallLogConfig = { transport: 'file', contentMode: 'content' };

const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Response fields that describe the call without carrying its content. */
const RAW_RESPONSE_METADATA_KEYS = ['id', 'type', 'role', 'model', 'stop_reason', 'stop_sequence', 'stop_details', 'usage', 'container'];

/** Strip everything that could carry conversation content from a call record. */
export function toMetadataOnly(record: Record<string, unknown>): Record<string, unknown> {
  const { rawRequest: _rq, rawResponse, response, requestSummary, error, ...rest } = record;
  const out: Record<string, unknown> = { ...rest };
  if (requestSummary && typeof requestSummary === 'object') {
    const { lastMessagePreview: _p, ...summary } = requestSummary as Record<string, unknown>;
    out.requestSummary = summary;
  }
  if (rawResponse && typeof rawResponse === 'object') {
    const raw = rawResponse as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const k of RAW_RESPONSE_METADATA_KEYS) if (raw[k] !== undefined) kept[k] = raw[k];
    if (Array.isArray(raw.content)) {
      kept.contentBlocks = (raw.content as Array<{ type?: string }>).map((b) => b?.type ?? 'unknown');
    }
    out.rawResponse = kept;
  }
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    out.response = {
      stopReason: r.stopReason ?? null,
      usage: r.usage ?? null,
      ...(Array.isArray(r.blocks)
        ? { blocks: (r.blocks as Array<Record<string, unknown>>).map(({ text: _t, ...b }) => b) }
        : {}),
    };
  }
  if (error !== undefined) {
    // Keep the error's identity and message; drop stacks (paths, not content,
    // but large and not needed for service health).
    out.error = error && typeof error === 'object'
      ? { name: (error as { name?: unknown }).name, message: (error as { message?: unknown }).message }
      : error;
  }
  return out;
}

export class LlmCallLog {
  readonly transport: LlmCallTransport;
  readonly contentMode: LlmCallContentMode;
  private readonly path: string;
  private readonly provider: string;

  constructor(opts: { path: string; provider: string } & Partial<LlmCallLogConfig>) {
    this.path = opts.path;
    this.provider = opts.provider;
    this.transport = opts.transport ?? DEFAULT_LLM_CALL_LOG_CONFIG.transport;
    this.contentMode = opts.contentMode ?? DEFAULT_LLM_CALL_LOG_CONFIG.contentMode;
  }

  /** True when callers may keep request bodies (refusal/full-payload capture). */
  get keepsContent(): boolean {
    return this.contentMode === 'content';
  }

  /** Never throws: observability must not affect provider traffic. */
  write(record: Record<string, unknown>, opts: { fsync?: boolean } = {}): void {
    try {
      const shaped = this.contentMode === 'metadata_only' ? toMetadataOnly(record) : record;
      let line = JSON.stringify(shaped);
      if (line.length > MAX_RECORD_BYTES) {
        const { rawRequest: _rq, rawResponse: _rr, ...rest } = shaped;
        line = JSON.stringify({ ...rest, truncated: 'raw bodies dropped (record exceeded size guard)' });
      }
      if (this.transport === 'stdout') {
        process.stdout.write(`${JSON.stringify({ logger: 'llm-calls', provider: this.provider, ...JSON.parse(line) })}\n`);
        return;
      }
      appendFileSync(this.path, line + '\n');
      if (opts.fsync) {
        const fd = openSync(this.path, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } catch {
      // never throw from logging
    }
  }
}
