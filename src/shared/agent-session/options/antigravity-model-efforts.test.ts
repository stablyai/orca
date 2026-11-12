import { expect, it } from 'vitest'
import { antigravityEffortRefusal, groupAntigravityModelEfforts } from './antigravity-model-efforts'

// Captured agy 1.4.11, Windows, 2026-11-09.
export const AGY_1411_MODELS = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
]

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
