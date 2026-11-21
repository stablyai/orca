import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../agent-session/agent-session-wire'
import { projectStructuredItemsToNativeChat } from '../../../agent-session/view/structured-agent-session-projection'
import { selectStructuredAgentTurnBars } from '../../../agent-session/view/structured-agent-session-turn-timing'
import { selectNativeChatTurnStatuses } from './native-chat-turn-status'
import { nativeChatTurnMembership } from './native-chat-turn-membership'
import { nativeChatTurnFold, nativeChatTurnFoldRow } from '../folding/native-chat-turn-fold'

function row(itemId: string, sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return {
    itemId,
    sequence,
    body,
    revision: 0,
    observedAt: 1_000 + sequence,
    turnScope: { kind: 'turn', turnItemId: 'tA' }
  }
}

const tail = [
  row('progress', 50, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Checking the files.' }]
  }),
  row('tool', 51, {
    kind: 'tool-call',
    name: 'shell',
    input: { command: 'ls' },
    callId: 'call-1',
    state: 'completed'
  }),
  row('answer', 52, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Done.' }]
  })
]

function latest(
  turn: Pick<AgentJournalTurnLifecycle, 'state' | 'completedAt'>
): AgentSessionLatestTurn {
  return {
    itemId: 'tA',
    observedAt: 1_001,
    turn: { turnId: 'tA', userItemId: 'A', startedAt: 1_000, ...turn }
  }
}

function foldedIds(latestTurn: AgentSessionLatestTurn): string[] {
  const messages = projectStructuredItemsToNativeChat(tail)
  const journal = { items: tail, submissions: [], latestTurn }
  const { turnKeys } = nativeChatTurnMembership(messages, journal)
  const { settledTurns } = selectStructuredAgentTurnBars(tail, [], null, latestTurn)
  const { completedByTurn } = selectNativeChatTurnStatuses(
    {},
    {
      activeTurnKey: 'none',
      isWorking: false,
      thinking: false,
      settledByTurn: settledTurns
    }
  )
  const settledTurnKeys = new Set(
    Object.entries(completedByTurn)
      .filter(([, status]) => status.workedSeconds != null)
      .map(([turnKey]) => turnKey)
  )
  const { foldedRows } = nativeChatTurnFold({
    rows: messages.map((message, index) => nativeChatTurnFoldRow(message, turnKeys[index], false)),
    settledTurnKeys,
    expandedTurnKeys: new Set()
  })
  return messages.filter((_, index) => foldedRows.has(index)).map((message) => message.id)
}

describe('a completed turn whose record is above the loaded rows', () => {
  it('folds its activity under the turn bar and keeps the answer visible', () => {
    const folded = foldedIds(latest({ state: 'completed', completedAt: 61_000 }))
    expect(folded).toEqual(['progress', 'tool'])
  })

  it('times the turn from the host record', () => {
    const { settledTurns } = selectStructuredAgentTurnBars(
      tail,
      [],
      null,
      latest({ state: 'completed', completedAt: 61_000 })
    )
    expect(settledTurns.get('tA')?.workedSeconds).toBe(60)
  })

  it('leaves a running turn unsettled', () => {
    const { settledTurns } = selectStructuredAgentTurnBars(
      tail,
      [],
      'tA',
      latest({ state: 'running' })
    )
    expect(settledTurns.has('tA')).toBe(false)
    expect(foldedIds(latest({ state: 'running' }))).toEqual([])
  })
})
