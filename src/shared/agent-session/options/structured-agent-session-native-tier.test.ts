import { expect, it } from 'vitest'
import { effectiveServiceTier } from './structured-agent-session-effective-tier'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  canSetStructuredAgentSessionOption,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-option-snapshot'

const choices = [
  { value: 'none', label: 'None' },
  { value: 'default', label: 'Default' },
  { value: 'flex', label: 'Flex' },
  { value: 'priority', label: 'Priority' }
]
const seed = { models: [], modelApply: {} }

it('keeps native literal default selectable and distinct from clearing an OMP tier', () => {
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('omp', seed),
    seed,
    {
      models: [
        { id: 'custom/gpt-4.1', label: 'GPT', isDefault: false, efforts: [], serviceTiers: choices }
      ],
      current: { model: 'custom/gpt-4.1', serviceTier: 'default' }
    }
  )
  const speed = structuredAgentSessionOptionSnapshot(state).find(
    (option) => option.id === 'serviceTier'
  )
  expect(speed?.kind).toMatchObject({
    type: 'select',
    currentValue: 'default'
  })
  expect(speed?.kind.type === 'select' && speed.kind.choices.map((choice) => choice.value)).toEqual(
    ['none', 'default', 'flex', 'priority']
  )
  expect(canSetStructuredAgentSessionOption(state, 'serviceTier', 'none')).toBe(true)
  expect(canSetStructuredAgentSessionOption(state, 'serviceTier', 'default')).toBe(true)
})

it('uses native none on a family switch but preserves an unlisted configured native value', () => {
  expect(
    effectiveServiceTier({
      tier: 'scale',
      modelTiers: ['none', 'priority'],
      listedTiers: ['none', 'scale', 'priority'],
      reported: true
    })
  ).toBe('none')
  expect(
    effectiveServiceTier({
      tier: 'future-native',
      modelTiers: ['none', 'priority'],
      listedTiers: ['none', 'priority'],
      reported: true
    })
  ).toBe('future-native')
  expect(
    effectiveServiceTier({ tier: 'flex', modelTiers: [], listedTiers: ['flex'], reported: true })
  ).toBe('default')
})

it('keeps a saved literal native default reversible when the model is unknown', () => {
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('omp', seed),
    seed,
    {
      models: [
        { id: 'custom/gpt-4.1', label: 'GPT', isDefault: false, efforts: [], serviceTiers: choices }
      ],
      current: { serviceTier: 'default' }
    }
  )
  const speed = structuredAgentSessionOptionSnapshot(state).find(
    (option) => option.id === 'serviceTier'
  )
  expect(speed?.kind.type === 'select' && speed.kind.choices.map((choice) => choice.value)).toEqual(
    ['none', 'default']
  )
  expect(canSetStructuredAgentSessionOption(state, 'serviceTier', 'none')).toBe(true)
})
