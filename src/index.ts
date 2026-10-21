/**
 * connectome-host — General-purpose agent TUI host with recipe-based configuration.
 *
 * Usage:
 *   bun src/index.ts                           # Start with saved/default recipe
 *   bun src/index.ts <recipe-url-or-path>      # Load recipe from URL or file
 *   bun src/index.ts --no-recipe               # Start fresh with default recipe
 *   bun src/index.ts --no-tui                  # Readline mode (works in pipes/CI)
 *   bun src/index.ts --headless                # Daemon mode: JSONL over Unix socket at $DATA_DIR/ipc.sock
 *   bun src/index.ts --headless --exit-when-idle   # One-shot: exit when agents go idle after first inference
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required (not needed for recipe provider "mock")
 *   MODEL               - Override model (default: from recipe or claude-opus-4-6)
 *   DATA_DIR            - Data directory for sessions (default: ./data)
 */

import { LoggingAnthropicAdapter } from './membrane/logging-adapter.js';
import { SettingsModule } from './modules/settings-module.js';
import { setupSynesthete } from './synesthete.js';
import {
  type Recipe,
  loadRecipeDetailed,
  saveRecipe,
  loadSavedRecipe,
  parseRecipeArg,
} from './recipe.js';
import { defaultMcplLogConfig, setupMcplStderrLog } from './logging/mcpl.js';
import type { AppContext } from './context.js';
import { createFramework } from './framework.js';
import { type Module, resolveTimeZone } from '@animalabs/agent-framework';
import { loadExtensions } from './extensions.js';
import { SessionManager } from './session-manager.js';
import { TimeModule } from './modules/time-module.js';
import { createMembrane } from './membrane/adapters.js';

declare const BUILD_SHA: string;
/** `git describe --always --dirty` at build time (`bun run build`); 'unbuilt' when run from source. */
export const CONHOST_BUILD = typeof BUILD_SHA === 'undefined' ? 'unbuilt' : BUILD_SHA;

// ---------------------------------------------------------------------------
// Recipe resolution
// ---------------------------------------------------------------------------

async function resolveRecipe(config: {
  dataDir: string,
}): Promise<Recipe> {
  const { source, noRecipe } = parseRecipeArg(process.argv);
  if (noRecipe) {
    throw new Error('Missing argument: recipePath');
  }

  if (source) {
    try {
      // Save the unresolved (pre-substitution) form: $DATA_DIR is typically
      // host-mounted and backed up, so resolved secrets must never land there.
      const { recipe, persistable } = await loadRecipeDetailed(source);
      saveRecipe(config.dataDir, persistable);
      console.log(`Loaded recipe: ${recipe.name}${recipe.description ? ` — ${recipe.description}` : ''}`);
      return recipe;
    } catch (err) {
      console.error(`Failed to load recipe from ${source}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // Try saved recipe. Re-resolves ${VAR} references against the CURRENT
  // environment, so a missing secret fails loudly here rather than starting
  // a misconfigured agent on the default recipe.
  try {
    const saved = await loadSavedRecipe(config.dataDir);
    if (!saved) throw new Error('Recipe not found');
    console.log(`Resuming recipe: ${saved.name}`);
    return saved;
  } catch (err) {
    throw new Error(`Failed to resume saved recipe from ${config.dataDir}:`, { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = process.env;
  const dataDir = env.DATA_DIR || null;
  if (!dataDir) {
    throw new Error('Missing env var: DATA_DIR');
  };

  const recipe = await resolveRecipe({ dataDir });
  const timeZone = resolveTimeZone(recipe.agent.timezone);

  const modules: Module[] = [];

  const sessionManager = new SessionManager(dataDir);
  sessionManager.migrateIfNeeded();
  let activeSession = sessionManager.getActiveSession();
  if (!activeSession) {
    activeSession = sessionManager.createSession();
  }
  const storePath = sessionManager.getStorePath(activeSession.id);

  const agentSettingsModule = new SettingsModule({
    reasoning: {
      enabled: recipe.agent.thinking?.enabled ?? false,
      budgetTokens: recipe.agent.thinking?.budgetTokens ?? 8192,
      display: recipe.agent.thinking?.display ?? 'summarized',
    },
  });
  modules.push(agentSettingsModule);

  const { membrane, adapter } = createMembrane({
    env,
    recipe,
    reasoningGetter: agentSettingsModule.getReasoning,
  });

  // Load recipe extensions first — custom strategies must be registered
  // before buildFrameworkStrategy runs, and custom modules join the module
  // list below. The loader is a dumb local import; see src/extensions.ts.
  const extensionRegistry = await loadExtensions(recipe);
  const framework = await createFramework({
    membrane,
    storePath,
    recipe,
    timeZone,
    dataDir,
    modules: [
      ...modules,
      new TimeModule(timeZone),
    ],
    extensionRegistry,
  });

  // Build app context
  const app: AppContext = {
    framework,
    membrane,
    sessionManager,
    recipe,
    agentName: recipe.agent.name,
    branchState: {
      undoStack: [],
      redoStack: [],
      checkpoints: new Map(),
    },
    userMessageCount: 0,
  };

  // Off-path refusal dragnet → ops alerts (observability M3): refusals on
  // non-streamed calls (compression/summarizer drains, maintenance) never
  // reach the framework's own noteRefusal — the 2026-07-15 mythos cascade
  // started exactly there, silently. Surface them through the same
  // opsAlert pipeline (failures.log + ops:alert trace + throttled webhook).
  // Reads app.framework (not the closure) so session switches stay wired;
  // feature-detects notifyOpsAlert for older framework versions.
  if (adapter instanceof LoggingAnthropicAdapter) {
    adapter.onRefusal = (info) => {
      app.framework.notifyOpsAlert?.(
        'refusal-offpath',
        app.agentName,
        `off-path refusal (category=${info.category ?? 'unknown'}) on a ${info.messages}-message ` +
        `complete() call (~${Math.round(info.inputTokens / 1000)}k tok) — likely compression/summarizer`,
        { ...info },
      );
    };
  }

  app.framework.start();
  setupSynesthete(app);
  setupMcplStderrLog(app, {
    ...defaultMcplLogConfig({ storePath }),
    ...(recipe.logging?.mcpl ?? {}),
  });

  try {
    const { runHeadless } = await import('./headless.js');
    await runHeadless(app, process.argv.slice(2));
  } finally {
    // @ts-ignore
    adapter?.dispose();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
