
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
