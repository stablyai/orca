import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  newestClaudeResponse,
  readClaudeSessionOptionsFromResponse
} from './claude-terminal-session-options'

const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
  value,
  label: value
}))

function listedModel(id: string, label: string): CatalogModel {
  return {
    id,
    label,
    options: [
      {
        id: 'effort',
        label: 'Effort',
        kind: { type: 'select', choices: EFFORT_CHOICES, defaultValue: 'high' },
        apply: {}
      }
    ]
  }
}

const LISTED = [
  listedModel('claude-opus-5-5', 'Claude Opus 5.5'),
  listedModel('claude-sonnet-5-5', 'Claude Sonnet 5.5')
]

function message(fields: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id' | 'role'>) {
  return { blocks: [], timestamp: null, source: 'transcript' as const, ...fields }
}

describe('Claude session options from the newest transcript response', () => {
  it('names the model and effort of the latest response, not earlier ones', () => {
    const messages: NativeChatMessage[] = [
      message({ id: '1', role: 'assistant', model: 'claude-sonnet-5-5', effort: 'high' }),
      message({ id: '2', role: 'user' }),
      message({ id: '3', role: 'assistant', model: 'claude-opus-5-5', effort: 'xhigh' }),
      message({ id: '4', role: 'assistant', source: 'hook' })
    ]

    expect(newestClaudeResponse(messages)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  it('names the model of a newest response that only thought', () => {
    const messages: NativeChatMessage[] = [
      message({ id: '1', role: 'assistant', model: 'claude-sonnet-5-5', effort: 'high' }),
      message({ id: '2', role: 'reasoning', model: 'claude-opus-5-5', effort: 'max' })
    ]

    expect(newestClaudeResponse(messages)).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
  })

  it('maps a listed model and keeps an unlisted one with its recorded effort', () => {
    expect(
      readClaudeSessionOptionsFromResponse({ model: 'claude-opus-5-5', effort: 'xhigh' }, LISTED)
    ).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(
      readClaudeSessionOptionsFromResponse({ model: 'claude-fable-5-2', effort: 'high' }, LISTED)
    ).toEqual({ model: 'claude-fable-5-2', effort: 'high' })
  })
})
