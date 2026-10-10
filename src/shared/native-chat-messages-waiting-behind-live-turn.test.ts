import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { nativeChatMessagesWaitingBehindLiveTurn } from './native-chat-messages-waiting-behind-live-turn'

/** A /compact whose turn record still reads running. */
const compactRunning: AgentJournalRenderItem[] = [
  {
    itemId: 'compact-entry',
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '/compact' }],
      command: { name: 'compact' }
    }
  },
  {
    itemId: 'compact-turn',
    revision: 0,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 'compact-turn', userItemId: 'compact-entry', state: 'running' }
  }
]
const queued = [{ id: 'card-1', role: 'user' as const, queued: true as const }]

describe('a queued card behind a running /compact', () => {
  it('waits behind it while the host says it runs, or an older host says nothing', () => {
    expect(nativeChatMessagesWaitingBehindLiveTurn(queued, compactRunning)).toEqual(
      new Set(['card-1'])
    )
    const latestTurn = {
      itemId: 'compact-turn',
      observedAt: 2,
      turn: { turnId: 'compact-turn', state: 'running' as const }
    }
    expect(
      nativeChatMessagesWaitingBehindLiveTurn(queued, compactRunning, false, [], { latestTurn })
    ).toEqual(new Set(['card-1']))
  })

  it('waits behind nothing once the host says no turn runs: the agent that ran it ended', () => {
    expect(
      nativeChatMessagesWaitingBehindLiveTurn(queued, compactRunning, false, [], {
        latestTurn: null,
        working: false
      })
    ).toEqual(new Set())
  })
})
