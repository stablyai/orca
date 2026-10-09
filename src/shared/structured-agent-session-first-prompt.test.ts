import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  firstStructuredAgentSessionPrompt,
  STRUCTURED_CHAT_NAME_PROMPT_LIMIT
} from './structured-agent-session-first-prompt'

function message(
  text: string,
  overrides: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return {
    itemId: 'message',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    ...overrides
  }
}

describe('first structured chat prompt', () => {
  it('reads the first root prose, skipping commands, subagents, and empty messages', () => {
    const command = message('/compact', {
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }
    })
    expect(
      firstStructuredAgentSessionPrompt([
        command,
        message('Child prompt', { agentId: 'child' }),
        message(''),
        message('Assistant', {
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Assistant' }]
          }
        }),
        message(' first user prompt '),
        message('later user prompt')
      ])
    ).toBe('first user prompt')
  })

  it('bounds a multi-block prompt before joining it', () => {
    const prompt = message('', {
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'x'.repeat(STRUCTURED_CHAT_NAME_PROMPT_LIMIT - 2) },
          { type: 'text', text: 'yz'.repeat(100_000) }
        ]
      }
    })
    const result = firstStructuredAgentSessionPrompt([prompt])
    expect(result).toHaveLength(STRUCTURED_CHAT_NAME_PROMPT_LIMIT)
    expect(result.endsWith('\ny')).toBe(true)
  })

  it('clips a single prompt block without splitting a Unicode character', () => {
    const prefix = 'A'.repeat(STRUCTURED_CHAT_NAME_PROMPT_LIMIT - 1)
    expect(firstStructuredAgentSessionPrompt([message(`${prefix}𠮷`)])).toBe(prefix)
  })

  it('clips a later prompt block without splitting a Unicode character', () => {
    const prefix = 'A'.repeat(STRUCTURED_CHAT_NAME_PROMPT_LIMIT - 2)
    const prompt = message('', {
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: prefix },
          { type: 'text', text: '𠮷' }
        ]
      }
    })
    expect(firstStructuredAgentSessionPrompt([prompt])).toBe(prefix)
  })

  it('skips punctuation-only entries in favor of the first text request', () => {
    expect(
      firstStructuredAgentSessionPrompt([message('?!'), message('修复登录'), message('Later')])
    ).toBe('修复登录')
    expect(firstStructuredAgentSessionPrompt([message('?!')])).toBe('')
  })

  it('retains a URL-only first request', () => {
    const url = 'https://example.test/issues/123'
    expect(firstStructuredAgentSessionPrompt([message(url), message('Later')])).toBe(url)
  })

  it('returns empty when no user prose exists', () => {
    expect(firstStructuredAgentSessionPrompt([])).toBe('')
    expect(firstStructuredAgentSessionPrompt([message('  ')])).toBe('')
  })
})
