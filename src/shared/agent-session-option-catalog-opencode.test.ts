import { describe, expect, it } from 'vitest'
import {
  getAgentSessionOptionCatalog,
  mergeCatalogModels,
  mergeDiscoveredAuthoritativeModels,
  type CatalogModel,
  type CatalogOption
} from './agent-session-option-catalog'
import { OPENCODE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-opencode'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { parseBuiltSessionOptionCommand } from './native-chat-session-option-commands'

function opencodeEffortOption(modelId = 'kr/claude-opus-4.7'): CatalogOption {
  const model = OPENCODE_SESSION_OPTION_CATALOG.models.find((candidate) => candidate.id === modelId)!
  return model.options.find((option) => option.id === 'effort')!
}

function effortValues(option: CatalogOption): string[] {
  return option.kind.type === 'select' ? option.kind.choices.map((choice) => choice.value) : []
}

describe('opencode session option catalog', () => {
  it('is registered for the opencode agent', () => {
    expect(getAgentSessionOptionCatalog('opencode')).toBe(OPENCODE_SESSION_OPTION_CATALOG)
  })

  it('seeds the 9router models, defaulting to opus', () => {
    expect(
      OPENCODE_SESSION_OPTION_CATALOG.models.map(({ id, label, isDefault }) => ({
        id,
        label,
        isDefault
      }))
    ).toEqual([
      { id: 'kr/claude-opus-4.7', label: 'Claude Opus 4.7', isDefault: true },
      { id: 'kr/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', isDefault: undefined },
      { id: 'kr/claude-sonnet-4.5-thinking-agentic', label: 'Claude Sonnet 4.5 Thinking', isDefault: undefined },
      { id: 'kr/claude-sonnet-4.5-agentic', label: 'Claude Sonnet 4.5 Agentic', isDefault: undefined },
      { id: 'kr/claude-haiku-4.5', label: 'Claude Haiku 4.5', isDefault: undefined },
      { id: 'kr/claude-haiku-4.5-thinking', label: 'Claude Haiku 4.5 Thinking', isDefault: undefined },
      { id: 'kr/claude-haiku-4.5-thinking-agentic', label: 'Claude Haiku 4.5 Thinking Agentic', isDefault: undefined },
      { id: 'kr/claude-haiku-4.5-agentic', label: 'Claude Haiku 4.5 Agentic', isDefault: undefined }
    ])
  })

  it('keeps the effort option shaped the way the picker and the wire expect', () => {
    const effort = opencodeEffortOption()
    expect(effort.id).toBe('effort')
    expect(effort.category).toBe('thought_level')
    expect(effort.kind).toMatchObject({ type: 'select', defaultValue: 'medium' })
  })

  it('offers only effort values the shared option labels localize', () => {
    const localized = ['low', 'medium', 'high']
    for (const model of OPENCODE_SESSION_OPTION_CATALOG.models) {
      for (const value of effortValues(opencodeEffortOption(model.id))) {
        expect(localized).toContain(value)
      }
    }
  })

  it('gives unknown model ids the effort menu launch reads from the seed', () => {
    const unknown = OPENCODE_SESSION_OPTION_CATALOG.unknownModelOptions ?? []
    expect(unknown.map(({ id }) => id)).toEqual(['effort'])
    expect(effortValues(unknown[0])).toEqual(['low', 'medium', 'high'])
  })

  it('does not treat discovery as authoritative', () => {
    expect(OPENCODE_SESSION_OPTION_CATALOG.discoveredModelsAreAuthoritative).toBeUndefined()
  })
})

describe('opencode launch args', () => {
  it('emits the model flag first, then effort', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.5', effort: 'low' })).toEqual({
      args: ['-m', 'kr/claude-sonnet-4.5', '--thinking', 'low'],
      appliedValues: { model: 'kr/claude-sonnet-4.5', effort: 'low' }
    })
  })

  it('emits exactly the two model tokens', () => {
    expect(OPENCODE_SESSION_OPTION_CATALOG.modelApply.launchArgs!('kr/claude-opus-4.7')).toEqual([
      '-m',
      'kr/claude-opus-4.7'
    ])
  })

  it('falls back to the seeded effort default when none is stored', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-opus-4.7' }).args).toEqual([
      '-m',
      'kr/claude-opus-4.7',
      '--thinking',
      'medium'
    ])
  })

  it('emits only -m for a persisted model the seed does not carry', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.6' })).toEqual({
      args: ['-m', 'kr/claude-sonnet-4.6'],
      appliedValues: { model: 'kr/claude-sonnet-4.6' }
    })
  })

  it('carries a picked effort onto a discovered model the seed never listed', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.6', effort: 'high' })).toEqual(
      {
        args: ['-m', 'kr/claude-sonnet-4.6', '--thinking', 'high'],
        appliedValues: { model: 'kr/claude-sonnet-4.6', effort: 'high' }
      }
    )
  })

  it('drops an effort value the menu does not offer on an unseeded model', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.6', effort: 'ultra' })
    ).toEqual({ args: ['-m', 'kr/claude-sonnet-4.6'], appliedValues: { model: 'kr/claude-sonnet-4.6' } })
  })

  it('honors a user effort flag over the picker on an unseeded model too', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.6', effort: 'low' }, [
        '--thinking=high'
      ]).appliedValues
    ).toEqual({ model: 'kr/claude-sonnet-4.6' })
  })

  it('still adds no effort default for a model the seed does not carry', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.6' }).args).toEqual([
      '-m',
      'kr/claude-sonnet-4.6'
    ])
  })

  it('spawns vanilla when no model was ever picked', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })
})

describe('opencode agentArgsOverride', () => {
  const modelOverride = OPENCODE_SESSION_OPTION_CATALOG.modelApply.agentArgsOverride!
  const effortOverride = opencodeEffortOption().apply.agentArgsOverride!

  it('detects a user-supplied model flag in every spelling', () => {
    for (const tokens of [
      ['-m', 'kr/claude-sonnet-4.6'],
      ['-mkr/claude-sonnet-4.6'],
      ['--model', 'kr/claude-sonnet-4.6'],
      ['--model=kr/claude-sonnet-4.6']
    ]) {
      expect(modelOverride(tokens)).toBe(true)
    }
  })

  it('does not fire on a different flag or a positional that contains -m', () => {
    expect(modelOverride(['--model-context', '8000'])).toBe(false)
    expect(modelOverride(['summarize-my-diff'])).toBe(false)
    expect(modelOverride(['--thinking', 'low'])).toBe(false)
    expect(modelOverride([])).toBe(false)
  })

  it('detects the thinking flag', () => {
    expect(effortOverride(['--thinking', 'low'])).toBe(true)
    expect(effortOverride(['--thinking=high'])).toBe(true)
    expect(effortOverride(['--effortless'])).toBe(false)
  })

  it('drops only the overridden key from the launch record', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.5', effort: 'high' }, [
        '--thinking=low'
      ])
    ).toEqual({
      args: ['-m', 'kr/claude-sonnet-4.5', '--thinking', 'high'],
      appliedValues: { model: 'kr/claude-sonnet-4.5' }
    })
  })

  it('cascades a model override onto the effort entry', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.5', effort: 'high' }, [
        '-m',
        'kr/claude-sonnet-4.6'
      ]).appliedValues
    ).toEqual({})
  })

  it('keeps the record intact when a lookalike flag is present', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'kr/claude-sonnet-4.5', effort: 'low' }, [
        '--model-context',
        '8000'
      ]).appliedValues
    ).toEqual({ model: 'kr/claude-sonnet-4.5', effort: 'low' })
  })
})

describe('opencode mid-session commands', () => {
  it('round-trips the model command through the built-command parser', () => {
    const midSession = OPENCODE_SESSION_OPTION_CATALOG.modelApply.midSession!
    if (midSession.kind !== 'command') {
      throw new Error('opencode model changes must be a typed command, not an agent picker')
    }
    expect(midSession.build('kr/claude-sonnet-4.5')).toBe('/model kr/claude-sonnet-4.5')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/model kr/claude-sonnet-4.5')).toBe('kr/claude-sonnet-4.5')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/effort low')).toBeNull()
  })

  it('round-trips the effort command', () => {
    const midSession = opencodeEffortOption().apply.midSession!
    if (midSession.kind !== 'command') {
      throw new Error('opencode effort changes must be a typed command')
    }
    expect(midSession.build('low')).toBe('/effort low')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/effort low')).toBe('low')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/effort ')).toBeNull()
  })
})

describe('mergeDiscoveredAuthoritativeModels', () => {
  const seed = OPENCODE_SESSION_OPTION_CATALOG.models
  const discovered = (...ids: string[]): CatalogModel[] =>
    ids.map((id) => ({ id, label: id, options: [] }))
  const mergedEffortValues = (model: CatalogModel): string[] => {
    const effort = model.options.find((option) => option.id === 'effort')
    return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
  }

  it('keeps a matched seed model option menu which discovery never carries', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, [
      { id: 'kr/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (live)', options: [] }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'kr/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (live)' })
    expect(mergedEffortValues(merged[0])).toEqual(['low', 'medium', 'high'])
  })

  it('takes the default flag from the probe and drops the seed stale one', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, [
      { id: 'kr/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', options: [] },
      { id: 'kr/claude-opus-5', label: 'Claude Opus 5', isDefault: true, options: [] }
    ])
    expect(merged.map(({ id, isDefault }) => [id, isDefault])).toEqual([
      ['kr/claude-sonnet-4.5', undefined],
      ['kr/claude-opus-5', true]
    ])
  })

  it('names no default when the probe marks none, rather than reviving the seed', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('kr/claude-sonnet-4.5'))
    expect(merged[0].isDefault).toBeUndefined()
    expect(merged[0].options.map(({ id }) => id)).toEqual(['effort'])
  })

  it('drops a seed model the account no longer lists', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('kr/claude-sonnet-4.6'))
    expect(merged.map(({ id }) => id)).toEqual(['kr/claude-sonnet-4.6'])
  })

  it('adds discovered models absent from the seed, lending them the default options', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('kr/claude-sonnet-4.5', 'kr/claude-sonnet-4.6'))
    expect(merged.map(({ id }) => id)).toEqual(['kr/claude-sonnet-4.5', 'kr/claude-sonnet-4.6'])
    expect(mergedEffortValues(merged[0])).toEqual(['low', 'medium', 'high'])
    expect(mergedEffortValues(merged[1])).toEqual(['low', 'medium', 'high'])
  })

  it('lends no options when the seed is empty', () => {
    expect(mergeDiscoveredAuthoritativeModels([], discovered('kr/claude-sonnet-4.6'))).toEqual([
      { id: 'kr/claude-sonnet-4.6', label: 'kr/claude-sonnet-4.6', options: [] }
    ])
  })

  it('preserves discovery order rather than seed order', () => {
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('kr/claude-sonnet-4.6', 'kr/claude-sonnet-4.5'))
    expect(merged.map(({ id }) => id)).toEqual(['kr/claude-sonnet-4.6', 'kr/claude-sonnet-4.5'])
  })

  it('publishes an empty list for an empty discovery, so callers must gate on it', () => {
    expect(mergeDiscoveredAuthoritativeModels(seed, [])).toEqual([])
  })

  it('drops the unmatched seed row the additive merge would have kept', () => {
    expect(mergeCatalogModels(seed, discovered('kr/claude-sonnet-4.6')).map(({ id }) => id)).toEqual([
      'kr/claude-opus-4.7',
      'kr/claude-sonnet-4.5',
      'kr/claude-sonnet-4.5-thinking-agentic',
      'kr/claude-sonnet-4.5-agentic',
      'kr/claude-haiku-4.5',
      'kr/claude-haiku-4.5-thinking',
      'kr/claude-haiku-4.5-thinking-agentic',
      'kr/claude-haiku-4.5-agentic',
      'kr/claude-sonnet-4.6'
    ])
    expect(
      mergeDiscoveredAuthoritativeModels(seed, discovered('kr/claude-sonnet-4.6')).map(({ id }) => id)
    ).toEqual(['kr/claude-sonnet-4.6'])
  })
})
