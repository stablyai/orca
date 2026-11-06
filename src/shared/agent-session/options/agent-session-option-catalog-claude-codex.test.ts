import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'

describe('codex reasoning effort catalog', () => {
  // Ceilings mirror `codex debug models`; a model must not offer a level its CLI rejects.
  it('caps each Codex model at the reasoning levels it actually supports', () => {
    const levelsFor = (modelId: string): string[] => {
      const effort = getAgentSessionOptionCatalog('codex')
        ?.models.find((model) => model.id === modelId)
        ?.options.find((option) => option.id === 'effort')
      return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
    }
    const upToXhigh = ['low', 'medium', 'high', 'xhigh']

    expect(levelsFor('gpt-5.6-sol')).toEqual([...upToXhigh, 'max', 'ultra'])
    expect(levelsFor('gpt-5.6-terra')).toEqual([...upToXhigh, 'max', 'ultra'])
    expect(levelsFor('gpt-5.6-luna')).toEqual([...upToXhigh, 'max'])
    expect(levelsFor('gpt-5.5')).toEqual(upToXhigh)
    expect(levelsFor('gpt-5.2-codex')).toEqual(upToXhigh)
  })

  // Unseeded/unknown Codex models get the widest ladder, since a model newer than this seed
  // usually supports max and ultra and Codex falls back rather than failing.
  it('offers the shared ultra ceiling for unseeded Codex models', () => {
    const option = getAgentSessionOptionCatalog('codex')?.unknownModelOptions?.find(
      (candidate) => candidate.id === 'effort'
    )
    expect(option?.kind.type === 'select' ? option.kind.choices.map((c) => c.value) : []).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra'
    ])
  })

  it('defaults GPT-5.6 Sol to its own low reasoning level', () => {
    const effort = getAgentSessionOptionCatalog('codex')
      ?.models.find((model) => model.id === 'gpt-5.6-sol')
      ?.options.find((option) => option.id === 'effort')
    expect(effort?.kind).toMatchObject({ defaultValue: 'low' })
  })

  it('defaults every other Codex model to medium reasoning effort', () => {
    const defaultFor = (modelId: string): unknown =>
      getAgentSessionOptionCatalog('codex')
        ?.models.find((model) => model.id === modelId)
        ?.options.find((option) => option.id === 'effort')?.kind

    for (const modelId of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2-codex']) {
      expect(defaultFor(modelId)).toMatchObject({ defaultValue: 'medium' })
    }
  })

  it('keeps every Codex effort default inside its choices', () => {
    const catalog = getAgentSessionOptionCatalog('codex')!
    const options = [
      ...catalog.models.flatMap((model) => model.options),
      ...(catalog.unknownModelOptions ?? [])
    ]
    for (const option of options) {
      if (option.id !== 'effort' || option.kind.type !== 'select') {
        continue
      }
      expect(option.kind.choices.map((choice) => choice.value)).toContain(option.kind.defaultValue)
    }
  })
})
