import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../agent-session/options/agent-session-option-catalog-claude-codex'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'

function snapshot(choices: string[], current: string, supported = true) {
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
            apply: {
              midSession: supported
                ? { kind: 'command', build: (value) => `/effort ${String(value)}` }
                : { kind: 'unsupported' }
            }
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
  it('keeps supported levels selectable when the reported effort is unlisted', () => {
    expect(snapshot(['low', 'medium', 'high'], 'extra-high')).toMatchObject({
      kind: {
        type: 'select',
        currentValue: 'extra-high',
        choices: [
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' }
        ]
      },
      valueSource: 'reported',
      settable: true
    })
  })

  it('retains unlisted effort as read-only when the catalog offers no adjustment', () => {
    expect(snapshot(['low'], 'extra-high')).toMatchObject({
      kind: { currentValue: 'extra-high', choices: [{ value: 'extra-high', label: 'extra-high' }] },
      settable: false
    })
  })

  it('preserves unsupported live transport restrictions for unlisted effort', () => {
    expect(snapshot(['low', 'high'], 'extra-high', false)).toMatchObject({
      kind: {
        choices: [
          { value: 'low', label: 'low' },
          { value: 'high', label: 'high' }
        ]
      },
      settable: false,
      disabledReason: 'set-when-session-starts'
    })
  })

  it('keeps an already listed single effort omitted', () => {
    expect(snapshot(['low'], 'low')).toBeUndefined()
  })
})
