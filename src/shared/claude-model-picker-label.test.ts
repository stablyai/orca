import { expect, it } from 'vitest'
import { claudeModelPickerLabel } from './claude-model-picker-label'

it.each([
  ['Opus (1M context)', 'claude-opus-5-5[1m]', undefined, 'Opus 5.5 (1M context)'],
  ['Sonnet', 'claude-sonnet-5', undefined, 'Sonnet 5'],
  ['Haiku', 'claude-haiku-4-5-20251001', undefined, 'Haiku 4.5'],
  [
    'Opus (1M context)',
    undefined,
    'Opus 5.5 with 1M context · Best for everyday tasks',
    'Opus 5.5 (1M context)'
  ],
  ['Opus', undefined, undefined, 'Opus'],
  ['Opus', 'claude-opus-latest', undefined, 'Opus'],
  ['Opus 5.0', 'claude-opus-5-5', undefined, 'Opus 5.0'],
  ['Private deployment', 'claude-opus-5-5', undefined, 'Private deployment'],
  ['Opus', 'claude-sonnet-5', 'Opus 5.5', 'Opus'],
  ['Opus', null, 'Compare to Sonnet 5', 'Opus']
])('labels %s using only reported identity', (label, resolved, description, expected) => {
  expect(claudeModelPickerLabel(label, resolved, description)).toBe(expected)
})
