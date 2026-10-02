import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  SettingsModule,
  type SettingsState,
} from '../src/modules/settings-module.js';

function context(saved?: Partial<SettingsState>) {
  let persisted: SettingsState | undefined;
  return {
    ctx: {
      getState: () => saved,
      setState: (state: SettingsState) => {
        persisted = structuredClone(state);
      },
    } as unknown as ModuleContext,
    persisted: () => persisted,
  };
}

describe('SettingsModule recipe baseline', () => {
  test('fresh state inherits enabled/display from recipe thinking', async () => {
    const module = SettingsModule.fromRecipeThinking({
      enabled: true,
      display: 'summarized',
    });
    const { ctx } = context();
    await module.start(ctx);

    expect(module.getReasoning()).toEqual({
      enabled: true,
      budgetTokens: 8192,
      display: 'summarized',
    });
  });

  test('persisted live settings override the recipe baseline', async () => {
    const module = SettingsModule.fromRecipeThinking({
      enabled: true,
      budgetTokens: 16_384,
      display: 'summarized',
    });
    const { ctx } = context({
      reasoning: { enabled: false, budgetTokens: 4096, display: 'omitted' },
    });
    await module.start(ctx);

    expect(module.getReasoning()).toEqual({
      enabled: false,
      budgetTokens: 4096,
      display: 'omitted',
    });
  });

  test('an unsaved session does not inherit the prior session live toggle', async () => {
    const module = SettingsModule.fromRecipeThinking({
      enabled: true,
      display: 'summarized',
    });
    const first = context({
      reasoning: { enabled: false, budgetTokens: 2048, display: 'omitted' },
    });
    await module.start(first.ctx);
    expect(module.getReasoning().enabled).toBe(false);

    await module.stop();
    const second = context();
    await module.start(second.ctx);
    expect(module.getReasoning()).toEqual({
      enabled: true,
      budgetTokens: 8192,
      display: 'summarized',
    });
  });

  test('partial older state falls back to the recipe baseline', async () => {
    const module = SettingsModule.fromRecipeThinking({
      enabled: true,
      display: 'summarized',
    });
    const { ctx } = context({ reasoning: { enabled: false } } as Partial<SettingsState>);
    await module.start(ctx);

    expect(module.getReasoning()).toEqual({
      enabled: false,
      budgetTokens: 8192,
      display: 'summarized',
    });
  });

  test('reset returns to recipe values rather than global defaults', async () => {
    const module = SettingsModule.fromRecipeThinking({
      enabled: true,
      budgetTokens: 16_384,
      display: 'summarized',
    });
    const holder = context();
    await module.start(holder.ctx);
    const extension = module.getAgentSettingsExtension();

    extension.update('Fabula', {
      reasoning_enabled: false,
      reasoning_budget_tokens: 2048,
      reasoning_display: 'omitted',
    });
    expect(module.getReasoning().enabled).toBe(false);

    const reset = extension.reset('Fabula');
    expect(reset).toEqual({
      reasoning_enabled: true,
      reasoning_budget_tokens: 16_384,
      reasoning_display: 'summarized',
    });
    expect(holder.persisted()?.reasoning).toEqual({
      enabled: true,
      budgetTokens: 16_384,
      display: 'summarized',
    });
  });
});
