import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import {
  firstStructuredAgentSessionPrompt,
  joinStructuredChatNamingPrompts,
  structuredAgentSessionUserPrompts
} from './structured-agent-session-first-prompt'

const userMessage = (itemId: string, text: string): AgentJournalRenderItem => ({
  itemId,
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
})

describe('structuredAgentSessionUserPrompts', () => {
  it('keeps every qualifying user turn and still returns only the first for auto-name', () => {
    const items = [
      userMessage('a', 'Fix the login timeout'),
      userMessage('b', 'Then add retry on 429'),
      {
        ...userMessage('c', '/compact'),
        body: {
          kind: 'message' as const,
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: '/compact' }],
          command: { name: 'compact' }
        }
      }
    ]
    expect(firstStructuredAgentSessionPrompt(items)).toBe('Fix the login timeout')
    expect(structuredAgentSessionUserPrompts(items)).toEqual([
      'Fix the login timeout',
      'Then add retry on 429'
    ])
  })
})

describe('joinStructuredChatNamingPrompts', () => {
  it('leaves a single turn unnumbered', () => {
    expect(joinStructuredChatNamingPrompts(['Fix the login timeout'])).toBe('Fix the login timeout')
  })

  it('numbers later turns so a regenerate title can use them', () => {
    expect(
      joinStructuredChatNamingPrompts(['Fix the login timeout', 'Then add retry on 429'])
    ).toBe('1. Fix the login timeout\n2. Then add retry on 429')
  })

  it('keeps the first and last turns when the joined text is longer than the regenerate budget', () => {
    const middle = 'm'.repeat(13_000)
    const joined = joinStructuredChatNamingPrompts(['head-turn', middle, 'tail-turn'])
    expect(joined.startsWith('1. head-turn')).toBe(true)
    expect(joined.endsWith('3. tail-turn')).toBe(true)
    expect(joined.includes('\n…\n')).toBe(true)
  })
})
