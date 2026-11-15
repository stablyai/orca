import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { selectNativeChatTurnStatuses } from '../../native-chat/transcript/turns/native-chat-turn-status'
import {
  selectStructuredAgentSettledTurns,
  structuredAgentTurnLocalStartedAt
} from './structured-agent-session-turn-timing'

let sequence = 0
function user(itemId: string): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: 1_000 + sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
  }
}
function lifecycle(
  turnId: string,
  lifecycle: Partial<
    NonNullable<AgentJournalRenderItem['body'] & { kind: 'status' }>['turnLifecycle']
  >,
  observedAt = 1_000 + sequence + 1
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `legacy:codex:s:turn-lifecycle%3A${turnId}`,
    revision: 1,
    sequence,
    observedAt,
    body: {
      kind: 'status',
      text: 'Codex is working…',
      turnLifecycle: { turnId, state: 'running', ...lifecycle }
    }
  }
}

describe('structuredAgentTurnLocalStartedAt', () => {
  it('moves the local first sighting back by the host-side append lag only', () => {
    const timing = { state: 'running' as const, startedAt: 50_000, observedAt: 52_500 }
    // Client clock is 1h ahead of the host: the anchor must not inherit that skew.
    expect(structuredAgentTurnLocalStartedAt(timing, 3_600_000 + 60_000)).toBe(3_600_000 + 57_500)
  })
})

describe('host-settled turns override local observation', () => {
  it('wins per turn and leaves locally observed turns from an older host intact', () => {
    const settled = selectStructuredAgentSettledTurns([
      user('u1'),
      lifecycle('t1', { state: 'completed', startedAt: 10_000, completedAt: 197_000 })
    ])
    const statuses = selectNativeChatTurnStatuses(
      { u0: { startedAt: 500, workedSeconds: 4 }, u1: { startedAt: 900, workedSeconds: 2 } },
      {
        activeTurnKey: 'u1',
        isWorking: false,
        thinking: false,
        settledByTurn: settled
      }
    )
    expect(statuses.completedByTurn.u1?.workedSeconds).toBe(187)
    expect(statuses.completedByTurn.u0?.workedSeconds).toBe(4)
    expect(statuses.active?.workedSeconds).toBe(187)
  })
})

describe('structuredAgentTurnLocalStartedAt with the host clock', () => {
  it('counts a mid-turn attach from the real start, not from first sight', () => {
    const timing = { state: 'running' as const, startedAt: 50_000, observedAt: 50_000 }
    // Host says the turn has run 40s; client clock is arbitrary.
    expect(structuredAgentTurnLocalStartedAt(timing, 3_600_000, 90_000)).toBe(3_600_000 - 40_000)
    expect(structuredAgentTurnLocalStartedAt(timing, 3_600_000, 40_000)).toBe(3_600_000)
  })
})

describe('a rejected send', () => {
  const rejected = (clientMessageId: string) => ({
    clientMessageId,
    fence: 5,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected' as const,
    providerItemId: null,
    reason: 'provider_write_failed: claude: not signed in',
    submittedAt: 1,
    resolvedAt: 2
  })

  // Local send timestamps cannot imply a zero-duration turn when the host proves the message never reached the provider.
  it('opened no turn, whatever the local clock observed', () => {
    const settled = selectStructuredAgentSettledTurns([user('orca:dead')], [rejected('dead')])
    expect(settled.get('orca:dead')).toBeNull()

    const statuses = selectNativeChatTurnStatuses(
      { 'orca:dead': { startedAt: 900, workedSeconds: 0 } },
      { activeTurnKey: 'orca:dead', isWorking: false, thinking: false, settledByTurn: settled }
    )
    expect(statuses.completedByTurn['orca:dead']).toBeUndefined()
    expect(statuses.active).toBeNull()
  })

  it('keeps the duration of a turn the journal does record for it', () => {
    const settled = selectStructuredAgentSettledTurns(
      [
        user('orca:ran'),
        lifecycle('t1', {
          state: 'interrupted',
          userItemId: 'orca:ran',
          startedAt: 10_000,
          completedAt: 14_000
        })
      ],
      [rejected('ran')]
    )
    expect(settled.get('orca:ran')).toEqual({
      startedAt: 10_000,
      workedSeconds: 4,
      verdict: 'interruption'
    })
  })

  // The folded header reads the verdict: a crash nobody asked for, versus a user's stop.
  it('carries how a settled turn ended, so its header can say a crash cut it off', () => {
    const ended = (userItemId: string, turn: Parameters<typeof lifecycle>[1]) => [
      user(userItemId),
      lifecycle(userItemId, { userItemId, startedAt: 10_000, completedAt: 22_000, ...turn })
    ]
    const settled = selectStructuredAgentSettledTurns([
      ...ended('orca:crashed', { state: 'interrupted' }),
      ...ended('orca:stopped', { state: 'interrupted', outcome: 'cancellation' }),
      ...ended('orca:finished', { state: 'completed', outcome: 'success' }),
      ...ended('orca:unjudged', { state: 'completed' })
    ])
    expect(settled.get('orca:crashed')).toEqual({
      startedAt: 10_000,
      workedSeconds: 12,
      verdict: 'interruption'
    })
    expect(settled.get('orca:stopped')).toMatchObject({ verdict: 'cancellation' })
    expect(settled.get('orca:finished')).toMatchObject({ verdict: 'success' })
    expect(settled.get('orca:unjudged')).toEqual({ startedAt: 10_000, workedSeconds: 12 })
    const statuses = selectNativeChatTurnStatuses(
      {},
      { activeTurnKey: 'orca:crashed', isWorking: false, thinking: false, settledByTurn: settled }
    )
    expect(statuses.active).toMatchObject({ workedSeconds: 12, verdict: 'interruption' })
  })
})
