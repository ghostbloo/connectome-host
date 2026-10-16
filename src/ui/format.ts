import type { ChildStatus } from "../modules/fleet-module";

/** Format a token count compactly: 1.2M / 3.5k / 42. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** Format elapsed seconds for humans: 48s / 5m48s / 1h02m. */
export function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Shared formatter — used by both the TUI process view and the /fleet list
// slash command so the two surfaces can't drift into different column sets.
// ---------------------------------------------------------------------------

/** Shape a row renderer needs from a FleetChild. */
export interface ChildRowView {
  name: string;
  status: ChildStatus;
  pid: number | null;
  startedAt: number;
  events: ReadonlyArray<unknown>;
}

/** Format a single child as a single-line status row (no color codes). */
export function formatChildRow(c: ChildRowView, now: number = Date.now()): string {
  const elapsed = Math.floor((now - c.startedAt) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const timeStr = min > 0 ? `${min}m${sec}s` : `${sec}s`;
  return `${c.name.padEnd(16)} ${c.status.padEnd(10)} pid=${(c.pid ?? '-').toString().padEnd(7)} ${timeStr.padEnd(6)} events=${c.events.length}`;
}
