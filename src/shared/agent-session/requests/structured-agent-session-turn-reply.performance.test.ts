import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../journal/agent-session-journal-types'
import { structuredAgentSessionTurnReply } from './structured-agent-session-turn-reply'

// STA-18083 (#47901): an answered read-only turn kept scanning every earlier reply-window row
// looking for a side effect nobody reads once the turn has an answer.
const say = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
const call = (name: string): AgentJournalItemBody => ({
  kind: 'tool-call',
  name,
  input: { file_path: 'a.ts' },
  state: 'completed'
})

function window(historyRows: number, turn: [string, AgentJournalItemBody][]) {
  const visited = new Set<string>()
  const row = (itemId: string, turnItemId: string, body: AgentJournalItemBody) => {
    const item: AgentJournalRenderItem = { itemId, revision: 1, sequence: 0, observedAt: 0, body }
    const turnScope = { kind: 'turn' as const, turnItemId }
    Object.defineProperty(item, 'turnScope', {
      get: () => {
        visited.add(itemId)
        return turnScope
      }
    })
    return item
  }
  const items = [
    ...Array.from({ length: historyRows }, (_, n) => row(`h${n}`, `old${n}`, call('Read'))),
    ...turn.map(([itemId, body]) => row(itemId, 't', body))
  ]
  return { items, rowsRead: () => visited.size }
}

describe('structuredAgentSessionTurnReply scan', () => {
  it.each([1_000, 10_000])('reads only the answer rows of an answered turn after %i rows', (h) => {
    const { items, rowsRead } = window(h, [
      ['t', call('Read')],
      ['a', say('done')]
    ])
    expect(structuredAgentSessionTurnReply(items, 't')).toEqual({
      prose: 'done',
      botProse: 'done',
      toolsRan: false
    })
    expect(rowsRead()).toBe(1)
  })

  it('still finds a side effect in a turn with no bot answer', () => {
    const { items } = window(1_000, [
      ['e', call('Edit')],
      ['a', say('looking')],
      ['r', call('Read')]
    ])
    expect(structuredAgentSessionTurnReply(items, 't')).toEqual({
      prose: 'looking',
      botProse: '',
      toolsRan: true
    })
  })
})
