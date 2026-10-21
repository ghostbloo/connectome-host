import {
  AnthropicXmlFormatter,
  Membrane,
  MockAdapter,
  NativeFormatter,
  OpenAICompatibleAdapter,
  OpenAIResponsesAPIAdapter,
  OpenAIResponsesFormatter,
  OpenRouterAdapter,
  ProviderAdapter,
} from "@animalabs/membrane";
import { CodexSubscriptionAdapter } from "./codex-subscription-adapter";
import { LoggingAnthropicAdapter, ReasoningGetter } from "./logging-adapter";
import { LoggingProviderAdapter } from "./logging-provider-wrapper";
import { LlmCallLog } from "../logging/llm-calls";
import type { Recipe, RecipeAgent } from "../recipe";
import { LoggingBedrockAdapter } from "./logging-bedrock-adapter";
import { logKeepaliveEvent } from "../logging/cache-keepalive-log";
import { membraneCachingOverride } from "./caching";

export type ProviderName = Required<RecipeAgent>['provider'];

interface CreateMembraneOptions {
  env: {
    // OAuth/Bearer token (e.g. a Claude subscription token). When set, it takes
    // precedence over the API key so requests never carry both auth schemes.
    ANTHROPIC_AUTH_TOKEN?: string,
    ANTHROPIC_API_KEY?: string,
    ANTHROPIC_BASE_URL?: string,

    BEDROCK_BASE_URL?: string,
    AWS_ACCESS_KEY_ID?: string,
    AWS_SECRET_ACCESS_KEY?: string,

    OPENAI_BASE_URL?: string,
    OPENAI_API_KEY?: string,
    OPENROUTER_API_KEY?: string,
    // Deliberately NO fallback to OPENAI_API_KEY: agent.baseUrl is
    // recipe-controlled, so a fallback would silently send a real OpenAI
    // credential as a Bearer token to whatever endpoint a recipe names.
    OPENAI_COMPATIBLE_API_KEY?: string,
    CODEX_BINARY?: string,
  },
  recipe: Recipe,
  reasoningGetter?: ReasoningGetter,
}

export function createMembrane(c: CreateMembraneOptions) {
  const adapter = createMembraneProviderAdapter(c);

  const membrane = new Membrane(adapter, {
    formatter: createMembraneFormatter({
      provider: c.recipe.agent.provider,
      formatter: c.recipe.agent.formatter,
    }),
    // Caching default for internal callers (autobio compression,
    // executeMerge), which read Membrane's defaultPromptCaching rather
    // than the per-agent flag. Applies on EVERY provider whenever the
    // recipe/model resolves an explicit answer — an Anthropic recipe with
    // promptCaching:false must disable internal calls too, and on bedrock
    // the model gate decides (see bedrockModelSupportsPromptCaching).
    ...membraneCachingOverride(c.recipe),
    // Anchor the assistant role for internal callers that don't set
    // request.assistantParticipant themselves (autobio compression,
    // executeMerge). Mismatch here flips stored assistant turns to
    // role: 'user' and the API rejects tool_use blocks riding along.
    assistantParticipant: c.recipe.agent.name,
  });

  return { membrane, adapter };
}

export function createMembraneFormatter({ provider, formatter }: { provider: string, formatter?: string }) {
  if (['openai-responses', 'openai-codex'].includes(provider)) {
    return new OpenAIResponsesFormatter();
  }
  if (formatter === 'anthropic-xml') {
    return new AnthropicXmlFormatter();
  }
  return new NativeFormatter();
}

export function createMembraneProviderAdapter(c: CreateMembraneOptions): ProviderAdapter {
  const {
    env,
    recipe,
    reasoningGetter,
  } = c;
  const provider = recipe.agent.provider;
  if (!provider) throw new Error('invalid recipe: missing recipe.agent.provider');
  const log = new LlmCallLog({ provider, ...(recipe.logging?.llmCalls ?? {}) });

  switch (provider) {
    case 'openai-responses': {
      return new LoggingProviderAdapter({
        inner: new OpenAIResponsesAPIAdapter({
          apiKey: env.OPENAI_API_KEY,
          baseURL: env.OPENAI_BASE_URL || undefined,
        }),
        log,
      });
    };
    case 'bedrock': {
      if (!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) {
        throw new Error('Missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY for recipe provider "bedrock".');
      }
      new LoggingBedrockAdapter({
        baseURL: env.BEDROCK_BASE_URL || undefined
      }, { log });
    };
    case 'mock': {
      return new LoggingProviderAdapter({
        inner: new MockAdapter({
          echoMode: recipe.agent.mock?.echoMode ?? true,
          ...(recipe.agent.mock?.defaultResponse !== undefined
            ? { defaultResponse: recipe.agent.mock.defaultResponse }
            : {}),
        }),
        log,
      });
    };
    case 'openrouter': {
      return new LoggingProviderAdapter({
        inner: new OpenRouterAdapter({
          apiKey: env.OPENROUTER_API_KEY,
          xTitle: recipe.agent.name ?? recipe.name,
        }),
        log,
      });
    };
    case 'openai-compatible': {
      return new LoggingProviderAdapter({
        inner: new OpenAICompatibleAdapter({
          baseURL: recipe.agent.baseUrl!,
          apiKey: env.OPENAI_COMPATIBLE_API_KEY || undefined,
          providerName: 'openai-compatible',
        }),
        log,
      });
    };
    case 'openai-codex': {
      return new LoggingProviderAdapter({
        inner: new CodexSubscriptionAdapter({
          codexBinary: env.CODEX_BINARY,
          fastMode: recipe.agent.codex?.fastMode ?? false,
        }),
        log,
      });
    };
    case 'anthropic': {
      // Anthropic OAuth wins over API-key auth when both are present.
      // Subscription tokens additionally require this beta header.
      // Recipe-declared betas (agent.anthropicBetas, e.g. context-1m)
      // are merged into the same anthropic-beta header either way.
      const authParams = (
        env.ANTHROPIC_AUTH_TOKEN ? { authToken: env.ANTHROPIC_AUTH_TOKEN }
        : (env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : null)
      );
      if (!authParams) {
        throw new Error('Missing env: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY');
      }

      const cacheKeepalive = recipe.agent.cacheKeepalive?.enabled === false ? undefined : {
        ...(recipe.agent.cacheKeepalive?.maxIdleHours !== undefined
          ? { maxIdleMs: recipe.agent.cacheKeepalive.maxIdleHours * 60 * 60_000 }
          : {}),
        ...(recipe.agent.cacheKeepalive?.refreshAfterMinutes !== undefined
          ? { refreshAfterMs: recipe.agent.cacheKeepalive.refreshAfterMinutes * 60_000 }
          : {}),
        // Every event — routine refreshes included — goes to stderr, so
        // all of them land in service-stderr.log next to
        // [inference-refusal]. See cache-keepalive-log.ts for why this is
        // not severity-routed.
        onEvent: logKeepaliveEvent,
      };

      const betaHeaders: string[] = [];
      if (env.ANTHROPIC_AUTH_TOKEN) betaHeaders.push('oauth-2025-04-20');
      betaHeaders.push(...(recipe.agent.anthropicBetas ?? []));

      return new LoggingAnthropicAdapter({
        config: {
          baseURL: env.ANTHROPIC_BASE_URL || undefined,
          defaultHeaders: {
            'anthropic-beta': betaHeaders.join(','),
          },
          ...authParams,

          // Hold this agent's cached prefix warm across idle gaps. Only fires
          // when the entry is actually near expiry, so a busy agent costs
          // nothing; only the 1h-TTL primary lane is eligible (the module
          // skips anything else). Off with cacheKeepalive.enabled: false.
          cacheKeepalive,
        },
        log,
        getReasoning: reasoningGetter,
      });
    }
  }
}
