import { describe, expect, it } from 'vitest'
import {
  applyNativeChatSessionOptionSettingsMutation,
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
    // Nothing here validates the id against the host; a retired one still resolves
    // and becomes `-m <id>`. Only clearing the persisted value prevents that.
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
    // settings.json is user-writable, so a non-string `effort` must not reach a
    // record typed Record<string, string> and be emitted as a turn option.
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
    // `valuesByModel` is merged over the resolved model, so a stored `model` key
    // can blank it. Emitting `{ model: '' }` fails the record's bounded-string
    // guard, and that throw is not a wire refusal code — it escapes as a raw
    // error the client reads as unknown, stranding the launch with no fallback.
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

  // A never-picked Fast preference must stay absent, not default on: seeding `true`
  // would silently move a user onto the faster tier they never chose.
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
    // An empty map fails the durable record's bounded-string guard, and
    // `agent_session_options_invalid` is not a wire refusal code: the throw escapes as a raw
    // error the client reads as unknown, stranding the launch with no fallback.
    expect(narrowStructuredLaunchSeedOptions(values as never)).toBeUndefined()
  })
})

describe('OMP configured thinking default', () => {
  const model = 'custom/model'
  const persisted: PersistedNativeChatSessionOptions = {
    omp: {
      model,
      valuesByModel: {
        [model]: { effort: 'high', serviceTier: 'standard' },
        'other/model': { effort: 'off' }
      }
    },
    codex: { model: 'gpt-5.6-sol', valuesByModel: {} }
  }

  it.each([undefined, 'other/model'])(
    'removes only the thinking override without adopting its model over %s',
    (savedModel) => {
      const starting = { ...persisted, omp: { ...persisted.omp, model: savedModel } }
      const reset = applyNativeChatSessionOptionSettingsMutation(starting, {
        type: 'apply-picks',
        agent: 'omp',
        picks: [{ modelId: model, optionId: 'effort', value: 'config-default' }]
      })
      expect(reset?.omp?.valuesByModel?.[model]).toEqual({ serviceTier: 'standard' })
      expect(reset?.omp?.valuesByModel?.['other/model']).toEqual({ effort: 'off' })
      expect(reset?.codex).toEqual(persisted.codex)
      expect(persisted.omp?.valuesByModel?.[model]?.effort).toBe('high')
      expect(resolveStructuredLaunchSeedOptions(reset, 'omp')).toEqual(
        savedModel ? { model: savedModel, effort: 'off' } : undefined
      )
    }
  )

  it('drops a legacy sentinel from OMP saved preferences before encoding startup records', () => {
    const legacy = {
      omp: { model, valuesByModel: { [model]: { effort: 'config-default' } } }
    }
    expect(resolveNativeChatSessionOptionDefaults(legacy, 'omp')).toEqual({ model })
    expect(resolveStructuredLaunchSeedOptions(legacy, 'omp')).toEqual({ model })
  })

  it('preserves another agent’s identically named effort through default resolution and seed encoding', () => {
    const selected: PersistedNativeChatSessionOptions = {
      grok: { model, valuesByModel: { [model]: { effort: 'config-default' } } }
    }
    expect(resolveStructuredLaunchSeedOptions(selected, 'grok')).toEqual({
      model,
      effort: 'config-default'
    })
  })

  it.each(['off', 'auto'])(
    'retains an explicit native %s preference in startup seeds',
    (effort) => {
      const selected = updateNativeChatSessionOptionDefaults({
        persisted,
        agent: 'omp',
        modelId: model,
        optionId: 'effort',
        value: effort
      })
      expect(resolveStructuredLaunchSeedOptions(selected, 'omp')).toEqual({
        model,
        effort,
        serviceTier: 'standard'
      })
    }
  )
})
