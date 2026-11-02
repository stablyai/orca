import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../agent-session/journal/agent-session-journal-types'
import type * as CommandEntry from '../agent-session/structured-agent-session-command-entry'
import { latestNativeChatUsageLimitCut } from './native-chat-usage-limit-cut'

const index = vi.hoisted(() => ({ builds: 0 }))
vi.mock('../agent-session/structured-agent-session-command-entry', async (importOriginal) => {
  const actual = await importOriginal<typeof CommandEntry>()
  return {
    ...actual,
    structuredAgentSessionCommandTurnItemIds: (items: readonly AgentJournalRenderItem[]) => {
      index.builds++
      return actual.structuredAgentSessionCommandTurnItemIds(items)
    }
  }
})

let sequence = 0
const row = (
  itemId: string,
  body: AgentJournalItemBody,
  turnItemId?: string
): AgentJournalRenderItem => ({
  itemId,
  revision: 1,
  sequence: ++sequence,
  observedAt: sequence,
  body,
  ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
})
const turn = (id: string, state: 'running' | 'completed'): AgentJournalItemBody => ({
  kind: 'turn',
  turnId: id,
  userItemId: `user-${id}`,
  state,
  startedAt: 1,
  ...(state === 'completed' ? { completedAt: 2, outcome: 'failure' as const } : {})
})

/** `history` finished turns, then a running turn that has streamed `streamed` rows. */
function conversation(history: number, streamed: number): AgentJournalRenderItem[] {
  const items: AgentJournalRenderItem[] = []
  for (const id of [...Array.from({ length: history }, (_, i) => `old-${i}`), 'live']) {
    items.push(
      row(`user-${id}`, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }),
      row(`turn-${id}`, turn(id, id === 'live' ? 'running' : 'completed'))
    )
  }
  for (let i = 0; i < streamed; i++) {
    items.push(
      row(
        `delta-${i}`,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'x' }] },
        'turn-live'
      )
    )
  }
  return items
}

function counted(items: readonly AgentJournalRenderItem[]) {
  const bodies = new Map(items.map((item) => [item.itemId, item.body]))
  const reads = { count: 0 }
  return {
    reads,
    bodyOf: (itemId: string) => {
      reads.count++
      return bodies.get(itemId)
    }
  }
}

describe('usage-limit cut on an indexed journal', () => {
  it('does work independent of history while streaming and on the final failed turn', () => {
    const perHistory = [500, 5_000].map((history) => {
      index.builds = 0
      const items = conversation(history, 50)
      const { reads, bodyOf } = counted(items)
      for (let streamed = 1; streamed <= 50; streamed += 7) {
        expect(
          latestNativeChatUsageLimitCut(items.slice(0, 2 * history + 2 + streamed), [], bodyOf)
        ).toBeNull()
      }
      const streamingReads = reads.count
      const ended = items.map((item) =>
        item.itemId === 'turn-live' ? { ...item, body: turn('live', 'completed') } : item
      )
      ended.push(
        row(
          'limit',
          {
            kind: 'status',
            ...agentSessionFailureWords(
              agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 9 } }),
              { surface: 'row' }
            )
          },
          'turn-live'
        )
      )
      const final = counted(ended)
      const cut = latestNativeChatUsageLimitCut(ended, [], final.bodyOf)
      expect(cut).toEqual({ turnItemId: 'turn-live', resetsAt: 9, turnEndedAt: 2 })
      // The unindexed path agrees, at the cost of indexing every item.
      expect(index.builds).toBe(0)
      expect(latestNativeChatUsageLimitCut(ended, [])).toEqual(cut)
      expect(index.builds).toBe(1)
      return { streamingReads, finalReads: final.reads.count }
    })
    expect(perHistory[1]).toEqual(perHistory[0])
  })
})
