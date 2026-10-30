import { describe, expect, it } from 'vitest'
import {
  mergeCatalogModels,
  mergeDiscoveredAuthoritativeModels,
  type CatalogModel,
  type CatalogOption
} from './agent-session-option-catalog'
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { parseBuiltSessionOptionCommand } from './native-chat/input/native-chat-session-option-commands'

function grokEffortOption(modelId = 'grok-4.7'): CatalogOption {
  const model = GROK_SESSION_OPTION_CATALOG.models.find((candidate) => candidate.id === modelId)!
  return model.options.find((option) => option.id === 'effort')!
}

function effortValues(option: CatalogOption): string[] {
  return option.kind.type === 'select' ? option.kind.choices.map((choice) => choice.value) : []
}

describe('grok session option catalog', () => {
  it('keeps the effort option shaped the way the picker and the wire expect', () => {
    const effort = grokEffortOption()
    // Keep effort: LaunchPreferences strips/rejects unknown keys at client/wire boundaries.
    expect(effort.id).toBe('effort')
    expect(effort.category).toBe('thought_level')
    // `high` is each model's own reported default, so an untouched picker never escalates.
    expect(effort.kind).toMatchObject({ type: 'select', defaultValue: 'high' })
    expect(grokEffortOption('grok-4.5').kind).toMatchObject({ defaultValue: 'high' })
  })

  it('offers each model only the tiers its own grok menu advertises', () => {
    // grok warns and ignores a tier the active model lacks, so 4.5 must not list xhigh.
    expect(effortValues(grokEffortOption('grok-4.7'))).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortValues(grokEffortOption('grok-4.6'))).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortValues(grokEffortOption('grok-4.5'))).toEqual(['low', 'medium', 'high'])
  })

  it('gives unknown model ids the widest effort menu launch reads from the seed', () => {
    const unknown = GROK_SESSION_OPTION_CATALOG.unknownModelOptions ?? []
    expect(unknown.map(({ id }) => id)).toEqual(['effort'])
    // A tier the menu withholds is unreachable, while an unsupported one only warns.
    expect(effortValues(unknown[0])).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})

describe('grok launch args', () => {
  it('emits the model flag first, then effort', () => {
    expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5', effort: 'low' })).toEqual({
      args: ['-m', 'grok-4.5', '--reasoning-effort', 'low'],
      appliedValues: { model: 'grok-4.5', effort: 'low' }
    })
  })

  it('carries the xhigh tier through to argv on a model that advertises it', () => {
    expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.6', effort: 'xhigh' })).toEqual(
      {
        args: ['-m', 'grok-4.6', '--reasoning-effort', 'xhigh'],
        appliedValues: { model: 'grok-4.6', effort: 'xhigh' }
      }
    )
  })

  it('falls back to the seeded effort default when none is stored', () => {
    // `high`, not the menu's ceiling: xhigh is opt-in, never a silent escalation.
    expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.6' }).args).toEqual([
      '-m',
      'grok-4.6',
      '--reasoning-effort',
      'high'
    ])
    expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5' }).args).toEqual([
      '-m',
      'grok-4.5',
      '--reasoning-effort',
      'high'
    ])
  })

  it('emits only -m for a persisted model the seed does not carry', () => {
    // A remembered model remains the launch selection even when discovery no longer lists it.
    expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-build' })).toEqual({
      args: ['-m', 'grok-build'],
      appliedValues: { model: 'grok-build' }
    })
  })

  it('carries a picked effort onto a discovered model the seed never listed', () => {
    // Static-seed resolution once dropped --reasoning-effort for discovered IDs absent from the seed.
    expect(resolveAgentSessionOptionLaunch('grok', { model: 'grok-build', effort: 'low' })).toEqual(
      {
        args: ['-m', 'grok-build', '--reasoning-effort', 'low'],
        appliedValues: { model: 'grok-build', effort: 'low' }
      }
    )
  })

  it('carries xhigh onto an unseeded model, whose menu is the widest one', () => {
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-build', effort: 'xhigh' })
    ).toEqual({
      args: ['-m', 'grok-build', '--reasoning-effort', 'xhigh'],
      appliedValues: { model: 'grok-build', effort: 'xhigh' }
    })
  })

  it('drops an effort value the menu does not offer on an unseeded model', () => {
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-build', effort: 'none' })
    ).toEqual({ args: ['-m', 'grok-build'], appliedValues: { model: 'grok-build' } })
  })

  it('honors a user effort flag over the picker on an unseeded model too', () => {
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-build', effort: 'low' }, [
        '--reasoning-effort=high'
      ]).appliedValues
    ).toEqual({ model: 'grok-build' })
  })

  it('resolves no picker args when no model was ever picked', () => {
    expect(resolveAgentSessionOptionLaunch('grok', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })
})

describe('grok agent-arg overrides', () => {
  const removeModel = GROK_SESSION_OPTION_CATALOG.modelApply.removeAgentArgs!
  const removeEffort = grokEffortOption().apply.removeAgentArgs!

  it('strips a user-supplied model flag in every spelling', () => {
    for (const tokens of [
      ['-m', 'grok-build'],
      ['-mgrok-build'],
      ['--model', 'grok-build'],
      ['--model=grok-build']
    ]) {
      expect(removeModel(tokens)).toEqual([])
    }
  })

  it('does not fire on a different flag or a positional that contains -m', () => {
    for (const tokens of [
      ['--model-context', '8000'],
      ['summarize-my-diff'],
      ['--reasoning-effort', 'low'],
      []
    ]) {
      expect(removeModel(tokens)).toEqual(tokens)
    }
  })

  it('strips both effort spellings', () => {
    expect(removeEffort(['--effort', 'low', '--reasoning-effort=high', '--keep'])).toEqual([
      '--keep'
    ])
    expect(removeEffort(['--effortless'])).toEqual(['--effortless'])
  })

  it('drops only the overridden key from the launch record and argv', () => {
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5', effort: 'high' }, [
        '--reasoning-effort=low'
      ])
    ).toEqual({
      args: ['-m', 'grok-4.5'],
      appliedValues: { model: 'grok-4.5' }
    })
  })

  it('cascades a model override onto the effort entry', () => {
    // User -m overrides can change the effort menu, invalidating the picker's evidence.
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5', effort: 'high' }, [
        '-m',
        'grok-build'
      ]).appliedValues
    ).toEqual({})
  })

  it('keeps the record intact when a lookalike flag is present', () => {
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5', effort: 'low' }, [
        '--model-context',
        '8000'
      ]).appliedValues
    ).toEqual({ model: 'grok-4.5', effort: 'low' })
  })
})

describe('grok mid-session commands', () => {
  it('round-trips the model command through the built-command parser', () => {
    const midSession = GROK_SESSION_OPTION_CATALOG.modelApply.midSession!
    if (midSession.kind !== 'command') {
      throw new Error('grok model changes must be a typed command, not an agent picker')
    }
    expect(midSession.build('grok-4.5')).toBe('/model grok-4.5')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/model grok-4.5')).toBe('grok-4.5')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/effort low')).toBeNull()
  })

  it('round-trips the effort command', () => {
    const midSession = grokEffortOption().apply.midSession!
    if (midSession.kind !== 'command') {
      throw new Error('grok effort changes must be a typed command')
    }
    expect(midSession.build('low')).toBe('/effort low')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/effort low')).toBe('low')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/effort ')).toBeNull()
  })
})

describe('mergeDiscoveredAuthoritativeModels', () => {
  const seed = GROK_SESSION_OPTION_CATALOG.models
  const discovered = (...ids: string[]): CatalogModel[] =>
    ids.map((id) => ({ id, label: id, options: [] }))
  const mergedEffortValues = (model: CatalogModel): string[] => {
    const effort = model.options.find((option) => option.id === 'effort')
    return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
  }

  it('keeps a matched seed model’s option menu, which discovery never carries', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, [
      { id: 'grok-4.5', label: 'Grok 4.5 (live)', options: [] }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'grok-4.5', label: 'Grok 4.5 (live)' })
    // Its own narrower menu, not the default row's — 4.5 has no xhigh tier.
    expect(mergedEffortValues(merged[0])).toEqual(['low', 'medium', 'high'])
  })

  it('takes the default flag from the probe and drops the seed’s stale one', () => {
    // Follow the account's default so the picker matches an unflagged launch.
    const merged = mergeDiscoveredAuthoritativeModels(seed, [
      { id: 'grok-4.5', label: 'Grok 4.5', options: [] },
      { id: 'grok-5', label: 'Grok 5', isDefault: true, options: [] }
    ])
    expect(merged.map(({ id, isDefault }) => [id, isDefault])).toEqual([
      ['grok-4.5', undefined],
      ['grok-5', true]
    ])
  })

  it('names no default when the probe marks none, rather than reviving the seed’s', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-4.5'))
    expect(merged[0].isDefault).toBeUndefined()
    // The seed's menu still survives — only the default claim is discovery's to make.
    expect(merged[0].options.map(({ id }) => id)).toEqual(['effort'])
  })

  it('gives a matched seed row its own menu, not the default row’s', () => {
    const multiSeed: CatalogModel[] = [
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: true, options: seed[0].options },
      { id: 'grok-lite', label: 'Grok Lite', options: [] }
    ]
    const merged = mergeDiscoveredAuthoritativeModels(multiSeed, discovered('grok-lite'))
    expect(merged.map(({ id }) => id)).toEqual(['grok-lite'])
    expect(merged[0].options).toEqual([])
  })

  it('drops a seed model the account no longer lists', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-build'))
    expect(merged.map(({ id }) => id)).toEqual(['grok-build'])
  })

  it('adds discovered models absent from the seed, lending them the default’s options', () => {
    // Unseeded models inherit the default row menu; seeded siblings keep their own narrower advertised menus.
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-4.5', 'grok-build'))
    expect(merged.map(({ id }) => id)).toEqual(['grok-4.5', 'grok-build'])
    expect(mergedEffortValues(merged[0])).toEqual(['low', 'medium', 'high'])
    expect(mergedEffortValues(merged[1])).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('takes the inherited options from the default seed row, not the first one', () => {
    const multiSeed: CatalogModel[] = [
      { id: 'legacy', label: 'Legacy', options: [] },
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: true, options: seed[0].options }
    ]
    const merged = mergeDiscoveredAuthoritativeModels(multiSeed, discovered('grok-build'))
    expect(merged[0].options.map(({ id }) => id)).toEqual(['effort'])
  })

  it('lends no options when the seed is empty', () => {
    expect(mergeDiscoveredAuthoritativeModels([], discovered('grok-build'))).toEqual([
      { id: 'grok-build', label: 'grok-build', options: [] }
    ])
  })

  it('preserves discovery order rather than seed order', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-build', 'grok-4.5'))
    expect(merged.map(({ id }) => id)).toEqual(['grok-build', 'grok-4.5'])
  })

  it('publishes an empty list for an empty discovery, so callers must gate on it', () => {
    // Only enrichment's non-empty guard keeps a failed probe from blanking the picker.
    expect(mergeDiscoveredAuthoritativeModels(seed, [])).toEqual([])
  })

  it('drops the unmatched seed row the additive merge would have kept', () => {
    expect(mergeCatalogModels(seed, discovered('grok-build')).map(({ id }) => id)).toEqual([
      'grok-4.7',
      'grok-4.6',
      'grok-4.5',
      'grok-build'
    ])
    expect(
      mergeDiscoveredAuthoritativeModels(seed, discovered('grok-build')).map(({ id }) => id)
    ).toEqual(['grok-build'])
  })
})
