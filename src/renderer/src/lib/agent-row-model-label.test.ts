import { describe, expect, it } from 'vitest'
import { formatAgentRowLabel, friendlyModel, labelNamesModel } from './agent-row-model-label'

describe('friendlyModel', () => {
  it('names the models Orca actually launches', () => {
    expect(friendlyModel('gpt-5.6-sol')).toBe('Sol')
    expect(friendlyModel('gpt-5.6-terra')).toBe('Terra')
    expect(friendlyModel('gpt-5.6-luna')).toBe('Luna')
    expect(friendlyModel('claude-fable-5')).toBe('Fable')
    expect(friendlyModel('claude-opus-5')).toBe('Opus')
    expect(friendlyModel('claude-sonnet-5')).toBe('Sonnet')
    expect(friendlyModel('claude-haiku-4-5-20251001')).toBe('Haiku')
  })

  it('falls back to the raw id rather than guessing', () => {
    expect(friendlyModel('gpt-oss-120b-medium')).toBe('gpt-oss-120b-medium')
    expect(friendlyModel('some-future-model')).toBe('some-future-model')
    // A substring inside another word is not a match.
    expect(friendlyModel('solar-preview')).toBe('solar-preview')
    expect(friendlyModel(undefined)).toBe('')
    expect(friendlyModel('   ')).toBe('')
  })
})

describe('formatAgentRowLabel', () => {
  it('renders a supervised parent as "Sol: feature"', () => {
    expect(formatAgentRowLabel({ model: 'gpt-5.6-sol', feature: 'Inspect scraper pipeline' })).toBe(
      'Sol: Inspect scraper pipeline'
    )
  })

  it('renders a Fable parent the same way', () => {
    expect(
      formatAgentRowLabel({ model: 'claude-fable-5', feature: 'Rework the replay gate' })
    ).toBe('Fable: Rework the replay gate')
  })

  it('renders a native child from its description', () => {
    expect(formatAgentRowLabel({ model: 'gpt-5.6-terra', feature: 'Map backend API layer' })).toBe(
      'Terra: Map backend API layer'
    )
    expect(
      formatAgentRowLabel({ model: 'claude-sonnet-5', feature: 'Survey the test suite' })
    ).toBe('Sonnet: Survey the test suite')
  })

  it('shows effort only when a caller supplies an authoritative one', () => {
    expect(
      formatAgentRowLabel({ model: 'gpt-5.6-terra', effort: 'medium', feature: 'Fix flake' })
    ).toBe('Terra (medium): Fix flake')
    expect(formatAgentRowLabel({ model: 'gpt-5.6-terra', feature: 'Fix flake' })).toBe(
      'Terra: Fix flake'
    )
  })

  it('keeps an unknown model readable instead of dropping it', () => {
    expect(formatAgentRowLabel({ model: 'mystery-model-1', feature: 'Do the thing' })).toBe(
      'mystery-model-1: Do the thing'
    )
  })

  it('leaves the feature untouched when there is no model', () => {
    expect(formatAgentRowLabel({ feature: 'Inspect scraper pipeline' })).toBe(
      'Inspect scraper pipeline'
    )
    expect(formatAgentRowLabel({ model: '', feature: 'Inspect scraper pipeline' })).toBe(
      'Inspect scraper pipeline'
    )
  })

  it('never double-prefixes a displayName the caller already formatted', () => {
    expect(
      formatAgentRowLabel({
        model: 'gpt-5.6-terra',
        feature: 'Terra (medium): Inspect scraper pipeline'
      })
    ).toBe('Terra (medium): Inspect scraper pipeline')
    expect(
      formatAgentRowLabel({ model: 'gpt-5.6-terra', feature: 'Terra: Inspect scraper pipeline' })
    ).toBe('Terra: Inspect scraper pipeline')
    // Even when the caller named a different model, adding a second prefix is worse.
    expect(
      formatAgentRowLabel({ model: 'gpt-5.6-terra', feature: 'Sonnet: Inspect scraper pipeline' })
    ).toBe('Sonnet: Inspect scraper pipeline')
  })

  it('degrades to the model alone when there is no feature name yet', () => {
    expect(formatAgentRowLabel({ model: 'gpt-5.6-sol', feature: '' })).toBe('Sol')
  })
})

describe('labelNamesModel', () => {
  it('reports whether the row still needs its separate model chip', () => {
    expect(labelNamesModel('Sol: Inspect scraper pipeline', 'gpt-5.6-sol')).toBe(true)
    expect(labelNamesModel('mystery-model-1: Do the thing', 'mystery-model-1')).toBe(true)
    expect(labelNamesModel('Inspect scraper pipeline', undefined)).toBe(false)
    expect(labelNamesModel('Inspect scraper pipeline', '')).toBe(false)
  })
})
