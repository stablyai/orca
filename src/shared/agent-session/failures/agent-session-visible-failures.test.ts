import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { agentSessionUnresolvedFailureRows } from './agent-session-visible-failures'

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
    text: 'Sign in to Pi.',
    failure: { kind: 'notSignedIn' }
  })
const turn = (id: string, outcome: 'success' | 'failure') =>
  row(id, { kind: 'turn', turnId: id, state: 'completed', outcome })

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
    expect(agentSessionUnresolvedFailureRows(items)).toEqual([])
  })

  it('keeps failures after the latest successful turn', () => {
    const items = [
      ask('ask-1'),
      turn('turn-1', 'success'),
      ask('ask-2'),
      turn('turn-2', 'failure'),
      signedOut('error-2')
    ]
    expect(agentSessionUnresolvedFailureRows(items)).toEqual(['error-2', 'ask-2'])
  })
})
