import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalTurnItem } from './agent-session-journal-types'
import { reduceNativeChatTurnTiming, selectNativeChatTurnStatuses } from './native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from './structured-agent-session-turn-timing'

function userItem(itemId: string): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence: 0,
    observedAt: 1_000,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  }
}

describe('authoritative unknown turn duration at the shared status consumer', () => {
  it('does not convert a running turn to local Worked for after unverifiable recovery', () => {
    const user: AgentJournalRenderItem = {
      itemId: 'orca:u1',
      revision: 0,
      sequence: 1,
      observedAt: 1_000,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    }
    const recoveredTurn: AgentJournalRenderItem = {
      itemId: 'legacy:codex:s:turn-lifecycle%3At1',
      revision: 2,
      sequence: 2,
      observedAt: 60_000,
      body: {
        kind: 'turn',
        turnId: 't1',
        userItemId: user.itemId,
        state: 'unverifiable',
        startedAt: 1_000
      }
    }
    const keys = new Set([user.itemId])
    const running = reduceNativeChatTurnTiming(
      {},
      {
        activeTurnKey: user.itemId,
        validTurnKeys: keys,
        isWorking: true,
        workingStartedAt: 1_000,
        now: 1_000
      }
    )
    const locallyStopped = reduceNativeChatTurnTiming(running, {
      activeTurnKey: user.itemId,
      validTurnKeys: keys,
      isWorking: false,
      workingStartedAt: null,
      now: 60_000
    })
    const options = {
      activeTurnKey: user.itemId,
      isWorking: false,
      hasCurrentTurnResponse: true,
      settledByTurn: selectStructuredAgentSettledTurns([user, recoveredTurn])
    }

    const mounted = selectNativeChatTurnStatuses(locallyStopped, options)
    const reloaded = selectNativeChatTurnStatuses({}, options)
    expect(mounted).toEqual(reloaded)
    expect(mounted.active).toBeNull()
    expect(mounted.completedByTurn).toEqual({})
  })

  it.each(['running', 'completed', 'interrupted'] as const)(
    'suppresses local completion for a host-recorded %s turn without an endpoint',
    (state) => {
      const item: AgentJournalRenderItem = {
        itemId: 'lifecycle-1',
        revision: 1,
        sequence: 1,
        observedAt: 1_000,
        body: { kind: 'turn', turnId: 't1', state, startedAt: 1_000, userItemId: 'turn-1' }
      }
      const statuses = selectNativeChatTurnStatuses(
        {
          'turn-1': { startedAt: 1_000, workedSeconds: 59 },
          next: { startedAt: 60_000, workedSeconds: null }
        },
        {
          activeTurnKey: 'next',
          isWorking: true,
          hasCurrentTurnResponse: true,
          settledByTurn: selectStructuredAgentSettledTurns([userItem('turn-1'), item])
        }
      )
      expect(statuses.completedByTurn).toEqual({})
      expect(statuses.active).toEqual({ startedAt: 60_000, workedSeconds: null, thinking: false })
    }
  )

  it('uses provider duration when present while preserving older-host local fallback', () => {
    const body: AgentJournalTurnItem = {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      startedAt: 1_000,
      userItemId: 'turn-1',
      durationMs: 7_172
    }
    const statuses = selectNativeChatTurnStatuses(
      {
        'turn-1': { startedAt: 1_000, workedSeconds: 59 },
        old: { startedAt: 1_000, workedSeconds: 9 }
      },
      {
        activeTurnKey: 'turn-1',
        isWorking: false,
        hasCurrentTurnResponse: true,
        settledByTurn: selectStructuredAgentSettledTurns([
          userItem('turn-1'),
          userItem('old'),
          { itemId: 'lifecycle-1', revision: 1, sequence: 1, observedAt: 10_000, body },
          {
            itemId: 'lifecycle-old',
            revision: 1,
            sequence: 2,
            observedAt: 10_000,
            body: { kind: 'turn', turnId: 'old', userItemId: 'old', state: 'completed' }
          }
        ])
      }
    )
    expect(statuses.active?.workedSeconds).toBe(7)
    expect(statuses.completedByTurn.old?.workedSeconds).toBe(9)
  })
})
