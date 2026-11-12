import { expect, it } from 'vitest'
import {
  antigravityEffortRefusal,
  antigravityTerminalCatalogModels,
  groupAntigravityModelEfforts
} from './antigravity-model-efforts'

// Captured agy 1.4.11, Windows, 2026-11-09.
export const AGY_1411_MODELS = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
]

it('keeps the bare High id in the family from the captured agy 1.5.6 listing', () => {
  const models = [
    { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (High)' },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)' }
  ]
  const grouped = groupAntigravityModelEfforts(models)
  expect(grouped).toEqual([
    {
      id: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      isDefault: false,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ],
      variants: {
        low: 'gemini-3.5-flash-low',
        medium: 'gemini-3.5-flash-medium',
        high: 'gemini-3.5-flash'
      }
    }
  ])
  expect(antigravityEffortRefusal(models, 'gemini-3.5-flash', 'high')).toBeUndefined()
  expect(antigravityTerminalCatalogModels(grouped).map(({ id }) => id)).toEqual([
    'gemini-3.5-flash',
    'gemini-3.5-flash-medium',
    'gemini-3.5-flash-low'
  ])
})

it('groups distinct bare and suffix levels without guessing duplicate or contradictory labels', () => {
  const bare = { id: 'family', label: 'Family (High)' }
  const low = { id: 'family-low', label: 'Family (High)' }
  for (const listing of [
    [bare, low],
    [low, bare]
  ]) {
    expect(groupAntigravityModelEfforts(listing)).toMatchObject([
      {
        id: 'family',
        label: 'Family',
        efforts: [{ value: 'low' }, { value: 'high' }],
        variants: { low: 'family-low', high: 'family' }
      }
    ])
  }
  expect(groupAntigravityModelEfforts([bare]).map(({ id, efforts }) => [id, efforts])).toEqual([
    ['family', []]
  ])
  const high = { id: 'family-high', label: 'Family (High)' }
  expect(
    groupAntigravityModelEfforts([bare, high]).map(({ id, efforts }) => [id, efforts])
  ).toEqual([
    ['family', []],
    ['family-high', []]
  ])
  expect(groupAntigravityModelEfforts([bare, low, high])[0]).toMatchObject({
    label: 'Family',
    variants: { low: 'family-low', high: 'family-high' }
  })
})

it('offers only distinct listed siblings, leaving lone suffixed and legacy models literal', () => {
  expect(
    groupAntigravityModelEfforts(AGY_1411_MODELS).map(({ id, efforts }) => [
      id,
      efforts.map(({ value }) => value)
    ])
  ).toEqual([
    ['gemini-3.8-flash', ['low', 'medium', 'high']],
    ['claude-sonnet-4-6', []],
    ['claude-opus-4-6-thinking', []],
    ['gpt-oss-120b-medium', []]
  ])
  expect(
    groupAntigravityModelEfforts([
      { id: 'family-low', label: 'Different' },
      { id: 'family-low', label: 'Repeated' },
      { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' }
    ]).map(({ id, efforts }) => [id, efforts])
  ).toEqual([
    ['family-low', []],
    ['Gemini 3.1 Pro (High)', []]
  ])
})

it('refuses conflicting explicit efforts using actual listed alternatives', () => {
  expect(antigravityEffortRefusal(AGY_1411_MODELS, 'gemini-3.8-flash', 'low')).toBeUndefined()
  expect(antigravityEffortRefusal(AGY_1411_MODELS, 'gemini-3.8-flash-high', 'high')).toBeUndefined()
  expect(antigravityEffortRefusal(AGY_1411_MODELS, 'gpt-oss-120b', 'medium')).toBeUndefined()
  expect(antigravityEffortRefusal(AGY_1411_MODELS, 'gpt-oss-120b', 'low')).toContain(
    '--model gpt-oss-120b-medium (without --effort)'
  )
  expect(antigravityEffortRefusal(AGY_1411_MODELS, 'gemini-3.8-flash-high', 'low')).toContain(
    '--model gemini-3.8-flash --effort low'
  )
  expect(antigravityEffortRefusal(AGY_1411_MODELS, 'claude-sonnet-4-6', 'low')).toContain(
    '--model claude-sonnet-4-6 (without --effort)'
  )
  expect(
    antigravityEffortRefusal(
      [{ id: 'Gemini 3.1 Pro', label: 'Gemini 3.1 Pro' }],
      'Gemini 3.1 Pro',
      'high'
    )
  ).toBeUndefined()
})

it('uses exact family identity before interpreting its suffix (synthetic naming regression)', () => {
  const rows = [
    { id: 'family-high-low', label: 'Low label' },
    { id: 'family-high-medium', label: 'Medium label' }
  ]
  expect(groupAntigravityModelEfforts(rows)[0].efforts.map(({ value }) => value)).toEqual([
    'low',
    'medium'
  ])
  expect(antigravityEffortRefusal(rows, 'family-high', 'low')).toBeUndefined()
  expect(antigravityEffortRefusal(rows, 'family-high-medium', 'low')).toContain(
    'already names Medium'
  )
  const bare = { id: 'family-high', label: 'Family High' }
  for (const listing of [
    [bare, ...rows],
    [...rows, bare]
  ]) {
    expect(
      groupAntigravityModelEfforts(listing).map(({ id, efforts }) => [
        id,
        efforts.map(({ value }) => value)
      ])
    ).toEqual([['family-high', ['low', 'medium']]])
    expect(antigravityEffortRefusal(listing, 'family-high', 'low')).toBeUndefined()
  }
})
