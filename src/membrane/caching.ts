import type { Recipe } from '../recipe.js';

/**
 * Prompt caching went GA on Bedrock in April 2025 for 3.5 Haiku, 3.7
 * Sonnet, and Claude 4+ — but NOT for 3.5 Sonnet (either version). 1022
 * ("3.6") was in the Dec 2024 preview and was dropped at GA — that
 * account-level "your request did not allow prompt caching" is the error
 * observed here 2026-07-21 (antra's diagnosis, confirmed against the AWS
 * docs 2026-07-31; as of the same day's live probe every 3.5-era model
 * is EOL on Bedrock anyway). So the gate denies the pre-GA FAMILIES —
 * Claude v2/instant, Claude 3, 3.5 Sonnet — at the family boundary, so
 * dated ids, bare aliases, -latest, and inference-profile forms
 * (us.anthropic.claude-...) all resolve the same; 3.5 Haiku and 3.7
 * Sonnet stay distinct and on. Non-Claude Bedrock ids (Nova etc.) are
 * out of scope for this gate and conservatively off — membrane's
 * BedrockAdapter only accepts Claude ids today. recipe.agent.
 * promptCaching overrides in either direction for accounts/regions
 * whose entitlements differ from the GA table. (Connectome issue #35.)
 */
export function bedrockModelSupportsPromptCaching(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.includes('claude')) return false;
  // (?![a-z0-9]) = family boundary: end of id, or a separator (-, ., :)
  // before a date/qualifier — matches the whole family, not one spelling.
  return !/claude-(v2|instant|3-(opus|sonnet|haiku)|3-5-sonnet)(?![a-z0-9])/.test(id);
}

export function resolvePromptCaching(recipe: Recipe): boolean | undefined {
  if (recipe.agent.promptCaching !== undefined) return recipe.agent.promptCaching;
  if (recipe.agent.provider === 'bedrock') return bedrockModelSupportsPromptCaching(recipe.agent.model);
  return undefined; // membrane default (on)
}

/**
 * Membrane-level counterpart of resolvePromptCaching, spread into the
 * Membrane constructor config. The per-agent flag only governs agent
 * inference; internal callers (autobio compression, executeMerge) read
 * Membrane's defaultPromptCaching — so an explicit recipe override must
 * land at BOTH layers, on every provider, or `promptCaching: false` on
 * an Anthropic recipe would silently keep caching on for internal calls.
 */
export function membraneCachingOverride(recipe: Recipe): { defaultPromptCaching?: boolean } {
  const promptCaching = resolvePromptCaching(recipe);
  return promptCaching === undefined ? {} : { defaultPromptCaching: promptCaching };
}

/** Content-free cache_control inventory from an actual provider payload. */
export function summarizeCacheControls(raw: unknown): { count: number; ttls: string[] } {
  let count = 0;
  const ttls: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (obj.cache_control && typeof obj.cache_control === 'object') {
      count++;
      const ttl = (obj.cache_control as Record<string, unknown>).ttl;
      ttls.push(typeof ttl === 'string' ? ttl : 'default');
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key !== 'cache_control') visit(child);
    }
  };
  visit(raw);
  return { count, ttls };
}
