import { describe, expect, it } from 'vitest'
import {
  filterSwitchableModelChoices,
  isCrossProviderStructuredModelChoice,
  parseStructuredModelChoice,
  structuredModelChoiceValue,
  withSwitchableStructuredModels
} from './structured-agent-session-switchable-models'
import type { SessionOptionDescriptor } from './native-chat-session-options'

const modelDescriptor = (
  currentValue: string,
  choices: { value: string; label: string }[]
): SessionOptionDescriptor => ({
  id: 'model',
  label: 'Model',
  category: 'model',
  transport: 'agent-session',
  kind: { type: 'select', currentValue, choices },
  valueSource: 'applied',
  settable: true
})

describe('structured switchable models', () => {
  it('namespaces model ids so grok and claude cannot collide', () => {
    expect(structuredModelChoiceValue('grok', 'grok-4.6')).toBe('grok:grok-4.6')
    expect(parseStructuredModelChoice('claude:sonnet')).toEqual({
      agent: 'claude',
      modelId: 'sonnet'
    })
    expect(parseStructuredModelChoice('sonnet')).toBeNull()
  })

  it('treats a grok→claude pick as a provider switch and same-provider as not', () => {
    expect(isCrossProviderStructuredModelChoice('grok', 'claude:sonnet')).toEqual({
      agent: 'claude',
      modelId: 'sonnet'
    })
    expect(isCrossProviderStructuredModelChoice('grok', 'grok:grok-4.5')).toBeNull()
    expect(isCrossProviderStructuredModelChoice('openclaude', 'claude:sonnet')).toBeNull()
  })

  it('groups seed catalogs and disables unsupported destinations', () => {
    const snapshot = withSwitchableStructuredModels(
      [modelDescriptor('grok-4.6', [{ value: 'grok-4.6', label: 'Grok 4.6' }])],
      {
        currentAgent: 'grok',
        live: {
          models: [{ id: 'grok-4.6', label: 'Grok 4.6', isDefault: true, efforts: [] }],
          current: { model: 'grok-4.6' }
        },
        supportedByAgent: { claude: false, grok: true }
      }
    )
    const model = snapshot[0]
    expect(model?.kind.type).toBe('select')
    if (model?.kind.type !== 'select') {
      return
    }
    expect(model.kind.currentValue).toBe('grok:grok-4.6')
    expect(
      model.kind.choices.some((choice) => choice.value === 'claude:sonnet' && choice.disabled)
    ).toBe(true)
    expect(model.kind.choices.some((choice) => choice.group === 'Grok')).toBe(true)
    expect(model.kind.choices.some((choice) => choice.group === 'Claude')).toBe(true)
  })

  it('filters model choices by label, group, or description', () => {
    const choices = withSwitchableStructuredModels(
      [modelDescriptor('grok-4.6', [{ value: 'grok-4.6', label: 'Grok 4.6' }])],
      {
        currentAgent: 'grok',
        live: {
          models: [{ id: 'grok-4.6', label: 'Grok 4.6', isDefault: true, efforts: [] }],
          current: { model: 'grok-4.6' }
        },
        supportedByAgent: {}
      }
    )[0]
    expect(choices?.kind.type).toBe('select')
    if (choices?.kind.type !== 'select') {
      return
    }
    expect(
      filterSwitchableModelChoices(choices.kind.choices, 'sonnet').every((choice) =>
        choice.label.toLowerCase().includes('sonnet')
      )
    ).toBe(true)
    expect(filterSwitchableModelChoices(choices.kind.choices, 'claude').length).toBeGreaterThan(0)
    expect(filterSwitchableModelChoices(choices.kind.choices, '')).toHaveLength(
      choices.kind.choices.length
    )
  })
})
