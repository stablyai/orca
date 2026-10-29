import { describe, expect, it } from 'vitest'
import {
  clearNativeChatSessionOptionModel,
  narrowStructuredLaunchSeedOptions,
  resolveNativeChatSessionOptionDefaults,
  resolveStructuredLaunchSeedOptions,
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
    // Stale ids pass through into -m; retirement must clear persisted model upstream.
    expect(resolveNativeChatSessionOptionDefaults(persistedGrok('grok-build'), 'grok')).toEqual({
      model: 'grok-build'
    })
  })
})

describe('resolveStructuredLaunchSeedOptions', () => {
  const persistedCodex = (
    valuesByModel: Record<string, Record<string, string | boolean>>
  ): PersistedNativeChatSessionOptions =>
    ({ codex: { model: 'gpt-5.6-sol', valuesByModel } }) as PersistedNativeChatSessionOptions

  it('seeds the saved model and effort a structured create must apply', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        persistedCodex({ 'gpt-5.6-sol': { effort: 'medium' } }),
        'codex'
      )
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
  })

  it('encodes Fast mode while dropping ids the providers only accept mid-session', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        persistedCodex({
          'gpt-5.6-sol': { effort: 'high', fastMode: true, personality: 'concise' }
        }),
        'codex'
      )
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high', fastMode: 'true' })
  })

  it('seeds a saved service tier', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        persistedCodex({ 'gpt-5.6-sol': { serviceTier: 'ultrafast' } }),
        'codex'
      )
    ).toEqual({ model: 'gpt-5.6-sol', serviceTier: 'ultrafast' })
  })

  it('drops a seeded id whose persisted value is not a usable string', () => {
    // User-writable settings may contain non-string options; never emit them into the durable string record.
    expect(
      resolveStructuredLaunchSeedOptions(
        persistedCodex({ 'gpt-5.6-sol': { effort: true } }),
        'codex'
      )
    ).toEqual({ model: 'gpt-5.6-sol' })
    expect(
      resolveStructuredLaunchSeedOptions(
        persistedCodex({ 'gpt-5.6-sol': { effort: '  ' } }),
        'codex'
      )
    ).toEqual({ model: 'gpt-5.6-sol' })
  })

  it('seeds nothing when the stored values empty the model out', () => {
    // valuesByModel can blank the model; bounded-string validation then throws outside wire refusals and strands launch fallback.
    expect(
      resolveStructuredLaunchSeedOptions(persistedCodex({ 'gpt-5.6-sol': { model: '' } }), 'codex')
    ).toBeUndefined()
  })

  it('seeds nothing until a model is picked, so the CLI default survives', () => {
    expect(resolveStructuredLaunchSeedOptions(undefined, 'codex')).toBeUndefined()
    expect(
      resolveStructuredLaunchSeedOptions({ codex: { valuesByModel: {} } }, 'codex')
    ).toBeUndefined()
  })
})

describe('narrowStructuredLaunchSeedOptions', () => {
  it('keeps the seedable ids an explicit selection names', () => {
    expect(
      narrowStructuredLaunchSeedOptions({ model: 'opus', effort: 'high', fastMode: false })
    ).toEqual({
      model: 'opus',
      effort: 'high',
      fastMode: 'false'
    })
  })

  // Absent Fast preference must stay absent; defaulting true changes service tier without a user choice.
  it('seeds no fastMode at all when the user never picked one', () => {
    expect(narrowStructuredLaunchSeedOptions({ model: 'opus', effort: 'high' })).toEqual({
      model: 'opus',
      effort: 'high'
    })
  })

  it('drops ids no structured create may seed', () => {
    expect(narrowStructuredLaunchSeedOptions({ model: 'opus', mode: 'plan' })).toEqual({
      model: 'opus'
    })
  })

  it.each([
    ['nothing at all', {}],
    ['whitespace only', { model: '   ', effort: '\t' }],
    ['no usable string', { model: 5, effort: null }],
    ['undefined', undefined]
  ])('resolves %s to undefined rather than {}', (_name, values) => {
    // Empty maps fail the durable guard outside wire-refusal handling, stranding fallback.
    expect(narrowStructuredLaunchSeedOptions(values as never)).toBeUndefined()
  })
})
