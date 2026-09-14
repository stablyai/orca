import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  hasUnansweredStructuredAgentSessionDispatch,
  selectStructuredAgentSessionQueuedSends
} from './structured-agent-session-queued-sends'

let sequence = 0

function turnRow(
  turnId: string,
  turn: { state: 'running' | 'completed'; startedAt: number; userItemId?: string }
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `legacy:claude:s:turn-lifecycle%3A${turnId}`,
    revision: 1,
    sequence,
    observedAt: turn.startedAt,
    body: { kind: 'turn', turnId, ...turn }
  }
}

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 10_000,
    resolvedAt: null,
    ...overrides
  }
}

describe('selectStructuredAgentSessionQueuedSends', () => {
  it('reports a pending send behind a turn that was already running', () => {
    const queued = selectStructuredAgentSessionQueuedSends(
      [turnRow('t1', { state: 'running', startedAt: 1_000 })],
      [submission('m2', { submittedAt: 34_000 })]
    )

    expect([...queued.values()]).toEqual([
      { clientMessageId: 'm2', submittedAt: 34_000, waitingOn: 'turn-busy' }
    ])
    expect(queued.has(agentJournalSubmissionKey('m2'))).toBe(true)
  })

  it('reports a pending send with no turn running as still starting', () => {
    const queued = selectStructuredAgentSessionQueuedSends([], [submission('m1')])

    expect([...queued.values()]).toEqual([
      { clientMessageId: 'm1', submittedAt: 10_000, waitingOn: 'turn-starting' }
    ])
  })

  it('reports nothing while the running turn may be this send own', () => {
    // The dispatch row and the turn row are written by two async paths off the
    // same echo: the turn can exist for a submission that is still pending.
    const queued = selectStructuredAgentSessionQueuedSends(
      [turnRow('t1', { state: 'running', startedAt: 34_000 })],
      [submission('m1', { submittedAt: 10_000 })]
    )

    expect([...queued.values()]).toEqual([])
  })

  it('is not a rename of "a turn is running": an answered send is never queued', () => {
    const queued = selectStructuredAgentSessionQueuedSends(
      [turnRow('t1', { state: 'running', startedAt: 1_000 })],
      [submission('m1', { dispatchState: 'accepted', submittedAt: 34_000 })]
    )

    expect([...queued.values()]).toEqual([])
  })

  it('keeps reporting the third send once the second send own turn is running', () => {
    // m2's turn started after m3 was accepted, so the start ordering alone
    // cannot rule it out — but m2 claims that turn by provider key, so it can.
    const queued = selectStructuredAgentSessionQueuedSends(
      [turnRow('t2', { state: 'running', startedAt: 40_000, userItemId: 'claude:s:echo-2' })],
      [
        submission('m2', {
          dispatchState: 'accepted',
          providerItemId: 'claude:s:echo-2',
          submittedAt: 20_000
        }),
        submission('m3', { submittedAt: 30_000 })
      ]
    )

    expect([...queued.values()]).toEqual([
      { clientMessageId: 'm3', submittedAt: 30_000, waitingOn: 'turn-busy' }
    ])
  })

  it('ignores sends fenced out by an older execution generation', () => {
    const queued = selectStructuredAgentSessionQueuedSends([], [submission('m1', { fence: 1 })], 2)

    expect([...queued.values()]).toEqual([])
  })

  it('shares one unanswered-dispatch rule with the session status projection', () => {
    const recovered = submission('m1', {
      dispatchState: 'unknown',
      recovered: true,
      resolvedAt: 11_000
    })

    expect(hasUnansweredStructuredAgentSessionDispatch([recovered])).toBe(false)
    expect([...selectStructuredAgentSessionQueuedSends([], [recovered]).values()]).toEqual([])
  })
})
