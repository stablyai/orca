import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../agent-session-option-catalog-claude-codex'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'

function snapshot(choices: string[], current: string) {
  const record = createNativeChatSessionOptionRecord('codex')
  record.model = { value: 'account-model', source: 'reported' }
  record.valuesByModel['account-model'] = { effort: { value: current, source: 'reported' } }
  return buildNativeChatSessionOptionSnapshot({
    catalog: CODEX_SESSION_OPTION_CATALOG,
    models: [
      {
        id: 'account-model',
        label: 'Account Model',
        options: [
          {
            id: 'effort',
            label: 'Effort',
            category: 'thought_level',
            kind: {
              type: 'select',
              defaultValue: 'low',
              choices: choices.map((value) => ({ value, label: value }))
            },
            apply: { midSession: { kind: 'unsupported' } }
          }
        ]
      }
    ],
    record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'catalog'
  }).find((option) => option.id === 'effort')
}

describe('catalog effort evidence', () => {
  it.each([{ choices: [] }, { choices: ['low'] }, { choices: ['low', 'high'] }])(
    'retains an unlisted effort as text with $choices offered choices',
    ({ choices }) => {
      expect(snapshot(choices, 'extra-high')).toMatchObject({
        kind: {
          type: 'select',
          currentValue: 'extra-high',
          choices: [{ value: 'extra-high', label: 'extra-high' }]
        },
        valueSource: 'reported',
        transport: 'catalog',
        settable: false
      })
      expect(snapshot(choices, 'extra-high')?.action).toBeUndefined()
    }
  )

  it('keeps an already listed single effort omitted', () => {
    expect(snapshot(['low'], 'low')).toBeUndefined()
  })
})
