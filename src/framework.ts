import { Membrane } from '@animalabs/membrane';
import path from 'node:path';
import { Recipe } from './recipe';
import {
  AgentFramework,
  type GateOptions,
  type Module,
  WorkspaceModule,
} from '@animalabs/agent-framework';
import type { ExtensionRegistry } from './extensions';
import { LessonsModule } from './modules/lessons-module';
import { RetrievalModule } from './modules/retrieval-module';
import { buildRetrievalModuleConfig } from './modules/retrieval-config';
import { buildWorkspaceMounts } from './mounts/workspace-mounts';
import { InstructionsModule } from './modules/instructions-module';
import { ActivityModule } from './modules/activity-module';
import { SubscriptionGcModule } from './modules/subscription-gc-module';
import { buildFrameworkStrategy, buildConversationsConfig } from './context-manager/framework-strategy';
import { loadMcplServers, DEFAULT_CONFIG_PATH, applyAgentOverlay, DEFAULT_AGENT_OVERLAY_PATH, composeMcplChildEnv } from './mcp/mcpl-config';
import { ChannelModeModule } from './modules/channel-mode-module';
import { IdentityModule } from './modules/identity-module';
import { McplAdminModule } from './modules/mcpl-admin-module';
import { resolvePromptCaching } from './membrane/caching';

export async function createFramework(opts: {
  membrane: Membrane,
  dataDir: string,
  storePath: string,
  recipe: Recipe,
  timeZone: string,
  modules: Module[],
  extensionRegistry: ExtensionRegistry,
}): Promise<AgentFramework> {
  const { membrane, dataDir, storePath, timeZone, recipe, extensionRegistry } = opts;
  const moduleInstances = opts.modules;
  
  const model = recipe.agent.model;
  const modules = recipe.modules ?? {};

  // Lessons. OPT-IN — not part of the standard recipe; enable explicitly via
  // modules.lessons for agents that curate a lesson library.
  let lessonsModule: LessonsModule | null = null;
  if (modules.lessons) {
    const globalLessonsPath = path.resolve(path.join(storePath, '..', '..', 'lessons.json'));
    lessonsModule = new LessonsModule({ globalPath: globalLessonsPath });
    moduleInstances.push(lessonsModule);

    // Retrieval (requires lessons). OPT-IN — not part of the standard recipe:
    // it injects context-dependent content into every compile (plus up to two
    // configured retrieval-model calls), which adds per-turn context churn.
    // Enable explicitly only when an agent actually curates a lesson library.
    if (modules.retrieval) {
      moduleInstances.push(new RetrievalModule(
        buildRetrievalModuleConfig(membrane, modules.retrieval, recipe.agent.provider),
      ));
    }
  }

  // Gate config — core AF EventGate feature.
  // Path is per-session: {storePath}/config/gate.json
  let gateOptions: GateOptions | undefined;
  if (modules.wake !== false) {
    gateOptions = { configPath: path.join(storePath, 'config', 'gate.json') };
    if (typeof modules.wake === 'object' && 'policies' in modules.wake) {
      gateOptions.config = modules.wake as import('@animalabs/agent-framework').GateConfig;
    }
    // Privileged-users file for the `sleep` tool — users who may wake the agent
    // through a sleep window. Stable across sessions (install-dir relative);
    // override with SLEEP_PRIVILEGED_FILE. Edit the file to change the list.
    gateOptions.privilegedUsersPath =
      process.env.SLEEP_PRIVILEGED_FILE || path.resolve('./sleep-privileged.json');
  }

  // Workspace (replaces FilesModule + LocalFilesModule)
  // Note: workspace: false disables ALL filesystem access (both read and write).
  // Previously LocalFilesModule was always-on; this is an intentional change —
  // recipes that need read-only access should keep workspace enabled (the default).
  // Mount construction lives in workspace-mounts.ts so recipe validation
  // reasons over the SAME mount flags the runtime builds (see that file's
  // header for why).
  let workspaceModule: WorkspaceModule | null = null;
  const workspaceMounts = buildWorkspaceMounts(modules.workspace, storePath);
  if (workspaceMounts) {
    workspaceModule = new WorkspaceModule({ mounts: workspaceMounts });
    moduleInstances.push(workspaceModule);
  }

  // Shared operating instructions — opt-in per recipe. Injects a living
  // instructions document (read through a workspace mount) into EVERY
  // agent's context on every turn — resident and ephemeral subagents alike —
  // via gatherContext. Requires the workspace module; validateRecipe rejects
  // the instructions+`workspace: false` pairing, so workspaceModule is
  // non-null here (the guard keeps the module fail-open regardless).
  if (modules.instructions) {
    const instructionsConfig =
      typeof modules.instructions === 'object' ? modules.instructions : {};
    const instructionsModule = new InstructionsModule(instructionsConfig);
    if (workspaceModule) instructionsModule.setWorkspace(workspaceModule);
    moduleInstances.push(instructionsModule);
  }

  // Activity (typing indicators) — opt-in per recipe
  let activityModule: ActivityModule | null = null;
  if (modules.activity !== undefined && modules.activity !== false) {
    const activityConfig = typeof modules.activity === 'object' ? modules.activity : {};
    activityModule = new ActivityModule({ initialChannels: activityConfig.channels });
    moduleInstances.push(activityModule);
  }

  // Auto-unsubscribe noisy ambient channels — ON by default (opt out with
  // `modules.subscriptionGc: false`).
  if (modules.subscriptionGc !== false) {
    const gcConfig =
      typeof modules.subscriptionGc === 'object' ? modules.subscriptionGc : {};
    moduleInstances.push(
      new SubscriptionGcModule({
        defaultLimitChars: gcConfig.defaultLimitChars,
        serverId: gcConfig.serverId,
        toolPrefix: gcConfig.toolPrefix,
      }),
    );
  }

  // Channel attention modes (`set_channel_mode`). Needs the gate to add/remove
  // the per-channel debounce policy, so only when `wake` is enabled. On by
  // default there (opt out with `modules.channelMode: false`); it only adds a
  // tool, inert until called.
  let channelModeModule: ChannelModeModule | null = null;
  if (gateOptions && modules.channelMode !== false) {
    const cmConfig =
      typeof modules.channelMode === 'object' ? modules.channelMode : {};
    channelModeModule = new ChannelModeModule({
      serverId: cmConfig.serverId,
      toolPrefix: cmConfig.toolPrefix,
      gcModuleName: cmConfig.gcModuleName,
      defaultDebounceMs: cmConfig.defaultDebounceMs,
    });
    moduleInstances.push(channelModeModule);
  }

  // MCPL self-administration — opt-in per recipe (grants the agent the
  // ability to spawn arbitrary commands via mcpl_deploy; see recipe.ts).
  let mcplAdminModule: McplAdminModule | null = null;
  if (modules.mcplAdmin === true || typeof modules.mcplAdmin === 'object') {
    const surface = typeof modules.mcplAdmin === 'object' ? modules.mcplAdmin.surface : undefined;
    mcplAdminModule = new McplAdminModule({ timeZone, ...(surface ? { surface } : {}) });
    moduleInstances.push(mcplAdminModule);
  }

  // Archipelago identity — opt-in per recipe. Utilities-only: enrollment is
  // one-time and token refresh is rare, so it costs no tool slots (see
  // identity-module.ts header). Keypair lives at the dataDir level — an
  // identity belongs to the deployment, not the session.
  let identityModule: IdentityModule | null = null;
  if (modules.identity !== undefined && modules.identity !== false) {
    const idCfg = typeof modules.identity === 'object' ? modules.identity : {};
    identityModule = new IdentityModule({
      keyPath: process.env.IDENTITY_KEY_FILE || path.resolve(dataDir, 'identity-key.pem'),
      home: idCfg.home ?? process.env.IDENTITY_HOME ?? 'id.animalabs.ai',
      ...(idCfg.audience ? { defaultAudience: idCfg.audience } : {}),
    });
    moduleInstances.push(identityModule);
  }

  // Extension-registered modules. Instantiated last so built-in modules keep
  // their historical positions; each factory gets the minimal runtime context
  // plus its declaring extension's config blob.
  const extensionModules: Module[] = [];
  for (const entry of extensionRegistry.modules) {
    const instance = entry.factory({ timeZone, storePath, model, config: entry.config });
    extensionModules.push(instance);
    moduleInstances.push(instance);
  }

  // -- Build MCP server list --
  //
  // Recipes are opt-in: a file entry from mcpl-servers.json is loaded only
  // when the recipe references its id under `mcpServers`. Credentials and
  // the spawn command come from the file; the recipe entry can override
  // policy fields (channelSubscription, toolPrefix, feature-set toggles,
  // reconnect). Recipes can also define new servers the file doesn't have
  // by supplying `command` or `url` themselves.
  //
  // The previous behavior loaded every file server for every recipe, which
  // silently flooded focused recipes (conductor, reviewer) with traffic
  // from channels the agent never asked to listen to.
  const recipeServers = recipe.mcpServers ?? {};
  const fileServers = loadMcplServers(DEFAULT_CONFIG_PATH);
  const fileServersById = new Map(fileServers.map(s => [s.id, s]));

  // A server entry has EITHER a `command` (stdio) or a `url` (WebSocket); the
  // framework's McplServerConfig now carries both as optional, so this local
  // type must too. Previously the url-only branch forced `command: undefined!`,
  // which then reached `spawn(undefined, …)` and crashed a network-MCPL recipe.
  const allServers: Array<{ id: string; command?: string; url?: string;[k: string]: unknown }> = [];
  for (const [id, recipeEntry] of Object.entries(recipeServers)) {
    const fileEntry = fileServersById.get(id);
    if (fileEntry) {
      const merged: Record<string, unknown> = { ...fileEntry };
      if (recipeEntry.channelSubscription !== undefined) merged.channelSubscription = recipeEntry.channelSubscription;
      if (recipeEntry.toolPrefix !== undefined) merged.toolPrefix = recipeEntry.toolPrefix;
      if (recipeEntry.enabledFeatureSets !== undefined) merged.enabledFeatureSets = recipeEntry.enabledFeatureSets;
      if (recipeEntry.disabledFeatureSets !== undefined) merged.disabledFeatureSets = recipeEntry.disabledFeatureSets;
      if (recipeEntry.enabledTools !== undefined) merged.enabledTools = recipeEntry.enabledTools;
      if (recipeEntry.disabledTools !== undefined) merged.disabledTools = recipeEntry.disabledTools;
      if (recipeEntry.reconnect !== undefined) merged.reconnect = recipeEntry.reconnect;
      if (recipeEntry.reconnectIntervalMs !== undefined) merged.reconnectIntervalMs = recipeEntry.reconnectIntervalMs;
      if (recipeEntry.reconnectMaxIntervalMs !== undefined) merged.reconnectMaxIntervalMs = recipeEntry.reconnectMaxIntervalMs;
      // Let a recipe override/adopt WebSocket transport for a file-defined server.
      if (recipeEntry.url !== undefined) merged.url = recipeEntry.url;
      if (recipeEntry.transport !== undefined) merged.transport = recipeEntry.transport;
      if (recipeEntry.token !== undefined) merged.token = recipeEntry.token;
      if (recipeEntry.access !== undefined) merged.access = recipeEntry.access;
      allServers.push(merged as { id: string; command?: string; url?: string;[k: string]: unknown });
    } else if (recipeEntry.command || recipeEntry.url) {
      // Recipe-defined server (not in the file config). Spread ALL recipe fields
      // (command OR url/transport/token, plus policy) verbatim — no fake command.
      allServers.push({ id, ...recipeEntry } as { id: string; command?: string; url?: string;[k: string]: unknown });
    }
  }

  // Apply the agent overlay (mcpl-servers.agent.json): servers the agent
  // deployed for itself load unconditionally (no recipe opt-in), and
  // tombstones suppress recipe/file servers the agent unloaded.
  const finalServers = applyAgentOverlay(allServers, DEFAULT_AGENT_OVERLAY_PATH).map((server) => {
    const withEnv: { id: string; command?: string; url?: string;[k: string]: unknown } = {
      ...server,
      // Stdio MCPL children inherit a single agent-facing wall clock plus the
      // framework's refusal-annotation suppression baseline (operator env
      // supersedes the baseline; see composeMcplChildEnv). Protocol
      // timestamps remain UTC; only their rendered text uses AGENT_TIMEZONE.
      env: composeMcplChildEnv(server.env as Record<string, string> | undefined, timeZone),
    };
    // `access` is a declarative name (recipe/file/overlay); the credential
    // provider it implies is attached HERE, at load time — fresh credential
    // per dial via the identity module, never serialized, never in model
    // context (see identity-module.ts header).
    if (typeof withEnv.access === 'string' && withEnv.access) {
      if (identityModule) {
        const identity = identityModule;
        const audience = withEnv.access as string;
        withEnv.accessProvider = () => identity.accessFor(audience);
      } else {
        console.error(
          `[mcpl] server "${server.id}": access "${withEnv.access}" declared but the recipe has no identity module — connecting without credentials`,
        );
      }
    }
    return withEnv;
  });

  // No server augmentation needed — gate is wired via FrameworkConfig.gate

  // -- Build strategy --
  const strategy = buildFrameworkStrategy({ recipe, timeZone, extensions: extensionRegistry });
  const promptCaching = resolvePromptCaching(recipe);

  // -- Create framework --
  const framework = await AgentFramework.create({
    storePath,
    membrane,
    agents: [{
      name: recipe.agent.name,
      model: recipe.agent.model,
      systemPrompt: recipe.agent.systemPrompt,
      maxTokens: recipe.agent.maxTokens ?? 16384,
      maxStreamTokens: recipe.agent.maxStreamTokens ?? 150000,
      contextBudgetTokens: recipe.agent.contextBudgetTokens,
      // cacheTtl is withheld at the HOST layer on bedrock: the transport
      // only has the default 5m cache, and older membrane releases forward
      // the ttl field Bedrock rejects. Note this is not the whole story —
      // Agent Framework still supplies its own default ('1h') downstream
      // when the host omits the field, and membrane ≥0.5.77 strips it at
      // the provider boundary before wire dispatch. Requests are safe, but
      // pre-adapter config is NOT cache-TTL telemetry; the wire truth lives
      // at the adapter.
      ...(recipe.agent.cacheTtl && recipe.agent.provider !== 'bedrock'
        && { cacheTtl: recipe.agent.cacheTtl }),
      ...(promptCaching !== undefined && { promptCaching }),
      // Prefill scaffold (anthropic-xml formatter), e.g. chapterx CLI-sim's
      // '<cmd>cat untitled.txt</cmd>' — part of migrating prefill-era bots.
      ...(recipe.agent.prefillUserMessage && { prefillUserMessage: recipe.agent.prefillUserMessage }),
      ...((recipe.agent.provider === 'openai-responses' || recipe.agent.provider === 'openai-codex') && {
        providerParams: {
          reasoning: {
            effort: recipe.agent.responses?.reasoningEffort ?? 'high',
            context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
          },
          ...(recipe.agent.provider === 'openai-responses' ? {
            ...(recipe.agent.responses?.serviceTier ? {
              service_tier: recipe.agent.responses.serviceTier,
            } : {}),
            ...(recipe.agent.responses?.compactThreshold ? {
              context_management: [{
                type: 'compaction',
                compact_threshold: recipe.agent.responses.compactThreshold,
              }],
            } : {}),
          } : {}),
        },
      }),
      strategy,
      ...(recipe.agent.thinking && { thinking: recipe.agent.thinking }),
      ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
      ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
        ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
        : {}),
      ...(recipe.agent.proseRouting !== undefined
        ? { proseRouting: recipe.agent.proseRouting }
        : {}),
      ...(recipe.agent.toolWrapperProseGuard !== undefined
        ? { toolWrapperProseGuard: recipe.agent.toolWrapperProseGuard }
        : {})
    }],
    modules: moduleInstances,
    mcplServers: finalServers,
    gate: gateOptions,
    timeZone,
    // Client-side programmatic tool calling (code_execution) — recipe opt-in.
    ...(recipe.codeExecution ? { codeExecution: recipe.codeExecution } : {}),
    // Per-channel conversation routing: the recipe agent becomes the trunk
    // template; forks get a fresh instance of the same recipe strategy.
    conversations: buildConversationsConfig(recipe, timeZone, extensionRegistry),
    // Tune-out's subconscious resident (agent-framework#77) — recipe opt-in,
    // passed through verbatim; the framework owns the defaults.
    ...(recipe.subconscious ? { subconscious: recipe.subconscious } : {}),
  });

  // Wire post-creation hooks
  // Compression-quarantine klaxon → the framework's ops-alert channel
  // (failures.log + ops:alert trace + CONNECTOME_OPS_WEBHOOK). The strategy
  // re-fires this every alarm interval for as long as ANY chunk is
  // quarantined: quarantined spans stay raw, the fold floor creeps, and the
  // picker eventually cannot fit the window — a guaranteed future outage
  // that must never be a silent state.
  // Duck-typed on both sides so version skew in either dep degrades to a
  // no-op (the strategy's own stderr klaxon still fires) instead of a crash.
  {
    const alarmCapable = strategy as unknown as {
      setQuarantineAlarmHandler?: (fn: (status: { count: number; keys: string[] }) => void) => void;
    };
    const notify = (framework as unknown as {
      notifyOps?: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void;
    }).notifyOps?.bind(framework);
    if (alarmCapable.setQuarantineAlarmHandler && notify) {
      alarmCapable.setQuarantineAlarmHandler((status) => {
        if (status.count === 0) {
          // All-clear travels the same channel the alarm did, under a
          // DISTINCT kind: the alarm kind's 15-min ops cooldown must never
          // swallow the stand-down (silence after an alarm is ambiguous).
          notify(
            'compression-quarantine-clear',
            recipe.agent.name,
            'compression quarantine EMPTY — all debt paid; alarm stands down.',
            { count: 0 },
          );
          return;
        }
        notify(
          'compression-quarantine',
          recipe.agent.name,
          `${status.count} chunk(s) in compression quarantine — spans stay raw and WILL eventually exhaust the context budget. Operator action required (inspect refusing content; branch, pin, or clear).`,
          { count: status.count, keys: status.keys },
        );
      });
    }
  }

  if (activityModule) {
    activityModule.setFramework(framework);
  }

  if (channelModeModule) {
    channelModeModule.setFramework(framework);
  }

  // Extension modules get the same duck-typed post-creation hook the
  // built-ins use: if the instance exposes setFramework, call it.
  for (const instance of extensionModules) {
    const hooked = instance as unknown as { setFramework?: (f: AgentFramework) => void };
    hooked.setFramework?.(framework);
  }

  if (mcplAdminModule) {
    mcplAdminModule.setFramework(framework);
    if (identityModule) mcplAdminModule.setIdentity(identityModule);
  }

  if (workspaceModule) {
    workspaceModule.initStore(framework.getStore());
  }

  return framework;
}
