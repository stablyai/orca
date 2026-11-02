import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session/journal/agent-session-journal-types'
import {
  projectStructuredAgentSessionStatusState,
  projectStructuredAgentSessionStatusSummary
} from './agent-session/view/structured-agent-session-projection'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

describe('the turn verdict on the status summary', () => {
  const user = item('u1', 1, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'go' }]
  })

  it('carries the newest settled turn verdict only while the session is idle', () => {
    const running = item('turn-running', 2, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'running'
    })
    expect(projectStructuredAgentSessionStatusSummary([user, running])).not.toHaveProperty(
      'turnOutcome'
    )
    const cancelled = item('turn-cancelled', 3, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(projectStructuredAgentSessionStatusSummary([user, cancelled])).toMatchObject({
      status: 'idle',
      turnOutcome: 'cancellation'
    })
  })

  it('reports no verdict for a completed turn the provider never judged', () => {
    const completed = item('turn-completed', 2, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed'
    })
    expect(projectStructuredAgentSessionStatusSummary([user, completed])).not.toHaveProperty(
      'turnOutcome'
    )
  })

  // With no verdict from the provider, the lifecycle the host settled is what the row reports.
  it.each([
    ['interrupted', 'interruption'],
    ['unverifiable', 'unconfirmed']
  ] as const)(
    'reads an %s turn the provider never judged as its host-observed end',
    (state, outcome) => {
      const ended = item('turn-ended', 2, { kind: 'turn', turnId: 'turn-1', state })
      expect(projectStructuredAgentSessionStatusSummary([user, ended])).toMatchObject({
        status: 'idle',
        turnOutcome: outcome
      })
    }
  )

  it("keeps the provider's own verdict over what the host observed of the end", () => {
    for (const outcome of ['cancellation', 'failure', 'success'] as const) {
      const judged = item('turn-judged', 2, {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome
      })
      expect(projectStructuredAgentSessionStatusSummary([user, judged])).toMatchObject({
        turnOutcome: outcome
      })
    }
  })

  it('keeps the observed end off the request the completion feed announces', () => {
    const ended = item('turn-ended', 2, { kind: 'turn', turnId: 'turn-1', state: 'interrupted' })
    expect(projectStructuredAgentSessionStatusState([user, ended]).latestRequest).toMatchObject({
      turnState: 'interrupted',
      outcome: null
    })
  })
})
