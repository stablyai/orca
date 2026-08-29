import { describe, expect, it } from 'vitest'
import {
  clearNativeChatSessionOptionModel,
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from './native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'

const persistedGrok = (
  model: string | undefined,
  valuesByModel: Record<string, Record<string, string>> = {}
): PersistedNativeChatSessionOptions => ({
  grok: { ...(model ? { model } : {}), valuesByModel }
})

describe('clearNativeChatSessionOptionModel', () => {
  it('drops the model a retired id would otherwise launch as -m', () => {
    const cleared = clearNativeChatSessionOptionModel(
      persistedGrok('grok-build', { 'grok-build': { effort: 'low' } }),
      'grok'
    )
    expect(cleared.grok?.model).toBeUndefined()
    // Resolution keys off `model`, so clearing it is what stops the flag going out.
    expect(resolveNativeChatSessionOptionDefaults(cleared, 'grok')).toBeUndefined()
  })

  it('keeps the per-model values so a reselect restores the old effort', () => {
    const cleared = clearNativeChatSessionOptionModel(
      persistedGrok('grok-build', { 'grok-build': { effort: 'low' } }),
      'grok'
    )
    expect(cleared.grok?.valuesByModel).toEqual({ 'grok-build': { effort: 'low' } })
    const reselected = updateNativeChatSessionOptionDefaults({
      persisted: cleared,
      agent: 'grok',
      modelId: 'grok-build',
      optionId: 'model',
      value: 'grok-build'
    })
    expect(resolveNativeChatSessionOptionDefaults(reselected, 'grok')).toEqual({
      model: 'grok-build',
      effort: 'low'
    })
  })

  it('leaves every other agent untouched', () => {
    const cleared = clearNativeChatSessionOptionModel(
      { ...persistedGrok('grok-build'), claude: { model: 'opus', valuesByModel: {} } },
      'grok'
    )
    expect(cleared.claude).toEqual({ model: 'opus', valuesByModel: {} })
  })

  it('is a no-op when nothing is persisted for the agent', () => {
    expect(clearNativeChatSessionOptionModel(undefined, 'grok')).toEqual({})
    expect(clearNativeChatSessionOptionModel({}, 'grok')).toEqual({})
    const untouched = persistedGrok(undefined, { 'grok-4.5': { effort: 'high' } })
    expect(clearNativeChatSessionOptionModel(untouched, 'grok')).toEqual(untouched)
  })
})

describe('resolveNativeChatSessionOptionDefaults', () => {
  it('emits nothing until a model is explicitly picked, preserving the CLI default', () => {
    expect(resolveNativeChatSessionOptionDefaults(undefined, 'grok')).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults(persistedGrok(undefined), 'grok')).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults(persistedGrok('   '), 'grok')).toBeUndefined()
  })

  it('returns a stale id verbatim, which is why retirement happens upstream', () => {
    // Nothing here validates the id against the host; a retired one still resolves
    // and becomes `-m <id>`. Only clearing the persisted value prevents that.
    expect(resolveNativeChatSessionOptionDefaults(persistedGrok('grok-build'), 'grok')).toEqual({
      model: 'grok-build'
    })
  })
})
