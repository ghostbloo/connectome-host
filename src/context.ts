import type { AgentFramework } from '@animalabs/agent-framework';
import type { Membrane } from '@animalabs/membrane';
import type { BranchState } from './commands.js';
import type { Recipe } from './recipe.js';
import type { SessionManager } from './session-manager.js';
import type { CodexSubscriptionAdapter } from './membrane/codex-subscription-adapter.js';

/** Imported lazily to avoid circular deps — index.ts re-exports the type. */
export interface AppContext {
  framework: AgentFramework;
  membrane: Membrane;
  sessionManager: SessionManager;
  codexAdapter?: CodexSubscriptionAdapter;
  recipe: Recipe;
  /**
   * Resolved at startup from recipe + active session's import sidecar +
   * default. Used downstream by createFramework, setupSynesthete, etc. so
   * the priority chain isn't recomputed (and potentially drifted) at each
   * call site. Stays stable across `switchSession` — see note in main().
   */
  agentName: string;
  branchState: BranchState;
  userMessageCount: number;
}

export function configFromEnv() {
  const config = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    // OAuth/Bearer token (e.g. a Claude subscription token). When set, it takes
    // precedence over the API key so requests never carry both auth schemes.
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    // Deliberately NO fallback to OPENAI_API_KEY: agent.baseUrl is
    // recipe-controlled, so a fallback would silently send a real OpenAI
    // credential as a Bearer token to whatever endpoint a recipe names.
    openaiCompatibleApiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    codexBinary: process.env.CODEX_BINARY,
    dataDir: process.env.DATA_DIR!,
  }
  
  if (!config.dataDir) {
    throw new Error('Missing runtime env var DATA_DIR');
  }

  return config;
}
