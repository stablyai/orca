import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { agentSessionUnresolvedFailureRows } from './agent-session-visible-failures'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'

let sequence = 0
function row(itemId: string, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 1, sequence, observedAt: sequence, body }
}

const ask = (id: string) =>
  row(id, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] })
const signedOut = (id: string) =>
  row(id, {
    kind: 'status',
    tone: 'error',
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
      agentName: 'Pi',
      surface: 'row'
    })
  })
const turn = (id: string, outcome: 'success' | 'failure', userItemId?: string) =>
  row(id, {
    kind: 'turn',
    turnId: id,
    state: 'completed',
    outcome,
    ...(userItemId ? { userItemId } : {})
  })

describe('agentSessionUnresolvedFailureRows', () => {
  it('resolves sign-in failures once a later turn succeeds', () => {
    const items = [
      ask('ask-1'),
      turn('turn-1', 'failure'),
      signedOut('error-1'),
      ask('ask-2'),
      turn('turn-2', 'failure'),
      signedOut('error-2'),
      ask('ask-3'),
      turn('turn-3', 'success'),
      row('reply', {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }]
      })
    ]
    expect(agentSessionUnresolvedFailureRows(items, { sentMessages: true })).toEqual([])
  })

  it('keeps failures after the latest successful turn', () => {
    const items = [
      ask('ask-1'),
      turn('turn-1', 'success'),
      ask('ask-2'),
      turn('turn-2', 'failure'),
      signedOut('error-2')
    ]
    expect(agentSessionUnresolvedFailureRows(items, { sentMessages: true })).toEqual([
      'error-2',
      'ask-2'
    ])
  })

  it('does not count a successful /compact as resolving a sign-in failure', () => {
    const items = [
      ask('ask-1'),
      turn('turn-1', 'failure'),
      signedOut('error-1'),
      row('compact', {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }),
      turn('turn-2', 'success', 'compact')
    ]
    expect(agentSessionUnresolvedFailureRows(items, { sentMessages: false })).toEqual(['error-1'])
  })
})
