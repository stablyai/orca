import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from './agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session/journal/agent-session-journal-item-key'
import { firstStructuredChatNamingPrompt } from './structured-chat-naming-eligibility'

function message(
  text: string,
  overrides: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey('first'),
    sequence: 1,
    revision: 1,
    observedAt: 200,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    ...overrides
  }
}

function snapshot(): AgentJournalSnapshot {
  return {
    sessionId: 'chat',
    cursor: { epoch: 'epoch', sequence: 1 },
    items: [message('Repair login')],
    submissions: [
      {
        clientMessageId: 'first',
        fence: 1,
        payloadFingerprint: 'payload',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 200,
        resolvedAt: null
      }
    ]
  }
}

describe('first-turn chat naming eligibility', () => {
  it('allows an admitted pending send or its accepted provider echo', () => {
    const state = snapshot()
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('Repair login')
    state.items[0] = message('Repair login', { itemId: 'provider-message' })
    state.submissions = state.submissions.map((send) => ({
      ...send,
      dispatchState: 'accepted',
      providerItemId: 'provider-message'
    }))
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('Repair login')
  })

  it('does not promote later prose after an empty first message', () => {
    const state = snapshot()
    state.items[0] = message('')
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
    state.items.push(message('Second turn', { itemId: 'second' }))
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
  })

  it('ignores commands, assistant output, and child messages when counting user inputs', () => {
    const state = snapshot()
    state.items.push(message('Child', { agentId: 'child', itemId: 'child' }))
    state.items.push(
      message('Assistant', {
        itemId: 'assistant',
        body: { kind: 'message', role: 'assistant', blocks: [] }
      })
    )
    state.items.push(
      message('/compact', {
        itemId: 'command',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }
      })
    )
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('Repair login')
  })

  it('does nothing without a root user message or matching submission', () => {
    const state = snapshot()
    state.items = []
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
    state.items = [message('Repair login')]
    state.submissions = []
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
    state.submissions = snapshot().submissions.map((send) => ({
      ...send,
      clientMessageId: 'other'
    }))
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
  })

  it('does not retry a first turn submitted before this host run', () => {
    const state = snapshot()
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('Repair login')
    expect(firstStructuredChatNamingPrompt(state, 201)).toBe('')
    expect(firstStructuredChatNamingPrompt(state, 300)).toBe('')
  })

  it('skips recovered submissions even if their clock appears new', () => {
    const state = snapshot()
    state.submissions = state.submissions.map((send) => ({ ...send, recovered: true }))
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
  })

  it.each(['rejected', 'unknown'] as const)('skips %s dispatches', (dispatchState) => {
    const state = snapshot()
    state.submissions = state.submissions.map((send) => ({ ...send, dispatchState }))
    expect(firstStructuredChatNamingPrompt(state, 100)).toBe('')
  })
})
