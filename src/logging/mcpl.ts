// ---------------------------------------------------------------------------
// MCPL subprocess stderr log — receipts for "why did that MCPL server break"
// ---------------------------------------------------------------------------
import type { AgentFramework } from '@animalabs/agent-framework';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';

const MCPL_STDERR_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB; rolls to .1 on overflow.

/** Render an mcpl:server-* connection-lifecycle trace as a log line, or null
 *  for trace types this sink doesn't record. Lifecycle lines are prefixed
 *  `[host]` to stand apart from the server's own stderr output. */
function formatMcplLifecycleLine(event: { type: string } & Record<string, unknown>): string | null {
  switch (event.type) {
    case 'mcpl:server-stderr':
      return String(event.line);
    case 'mcpl:server-connect-failed':
      return `[host] connect failed (attempt ${event.attempt}, ${event.willRetry ? 'will retry' : 'NO RETRY — server unavailable until restart'}): ${event.error}`;
    case 'mcpl:server-reconnected':
      return `[host] reconnected after ${event.attempts} attempt(s)`;
    case 'mcpl:server-closed':
      return `[host] connection closed (code=${event.code}, signal=${event.signal}${event.willReconnect ? ', reconnect scheduled' : ''})`;
    case 'mcpl:server-error':
      return `[host] connection error: ${event.error}`;
    default:
      return null;
  }
}

export interface McplLogConfig {
  transport: 'file' | 'stdout';
  /** Directory for file transport. Defaults to `<storePath>/mcpl-stderr/` (per session). */
  dir?: string;
}

export function defaultMcplLogConfig({ storePath }: { storePath: string }): McplLogConfig & { dir: string } {
  return {
    transport: 'file',
    dir: path.join(storePath, 'mcpl-stderr'),
  };
}

export function setupMcplStderrLog(app: { framework: AgentFramework }, config: McplLogConfig): void {
  if (config.transport === 'file') {
    if (!config.dir) {
      console.warn('[host] mcpl-stderr with transport "file" requires "dir" to be set, falling back to stdout');
    } else {
      // Best-effort directory creation — if it fails, per-write attempts will too,
      // and we'll swallow those quietly. We don't want logging to be load-bearing.
      void mkdir(config.dir!, { recursive: true }).catch(() => {});
    }
  }

  app.framework.onTrace((event) => {
    const e = event as unknown as { type: string; serverId?: string; timestamp: number } & Record<string, unknown>;
    if (typeof e.serverId !== 'string') return;
    const line = formatMcplLifecycleLine(e);
    if (line === null) return;
    const iso = new Date(e.timestamp).toISOString();
    if (config.transport === 'file' && config.dir) {
      // basename guards against a misconfigured serverId like "../foo" escaping dir.
      const logPath = path.join(config.dir, `${path.basename(e.serverId)}.log`);
      const entry = `${iso} ${line}\n`;
      void rotateIfNeeded(logPath, entry.length)
        .then(() => appendFile(logPath, entry))
        .catch(() => {
          // If logging itself fails, don't cascade.
        });
    } else {
      // process.stdout.write, not console.log: one JSON line, and it goes
      // wherever the host's stdout goes (a file in headless 'file' mode).
      process.stdout.write(`${JSON.stringify({ logger: 'mcpl', ts: iso, server: e.serverId, event: e.type, line })}\n`);
    }
  });
}

async function rotateIfNeeded(logPath: string, incomingBytes: number): Promise<void> {
  try {
    const s = await stat(logPath);
    if (s.size + incomingBytes > MCPL_STDERR_LOG_MAX_BYTES) {
      await rename(logPath, `${logPath}.1`);
    }
  } catch {
    // No existing file (or stat failed) — nothing to rotate.
  }
}
