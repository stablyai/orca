// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  noteStreamedTextProjection,
  noteStreamedTextRevision,
  noteStreamedTextStage,
  projectionBesideStreamedText
} from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { nativeChatSubagentEnding } from './native-chat-subagent-ending'
import { useNativeChatSubagentScope } from './use-native-chat-subagent-scope'

vi.mock('./native-chat-subagent-ending', { spy: true })

afterEach(cleanup)

const message = (id: string, text: string, agentId?: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript',
  ...(agentId ? { agentId } : {})
})

const journalRow = (text: string): AgentJournalRenderItem => ({
  itemId: 'parent-reply',
  revision: 1,
  sequence: 2,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

const rows = (...messages: NativeChatMessage[]): NativeChatSubagentRow[] =>
  messages.map((entry) => ({ message: entry, turnKey: undefined }))

// Perf contract: a finished subagent's open view draws the same rows, and doesn't re-read its
// ending, while a sibling subagent or the parent conversation streams; only its own change does.
it("holds an open finished subagent's view while others stream", () => {
  const child = rows(message('child-1', 'The full answer.', 'child'))
  const roster = new Map([
    [
      'child',
      {
        entry: {
          id: 'child',
          label: 'Child',
          state: 'completed' as const,
          lastMessage: 'The full answer.'
        },
        rosterItemId: 'roster',
        rosterPosition: { sequence: 1, index: 0 },
        rosterRevision: 1
      }
    ]
  ])
  let journal = [journalRow('The parent so far')]
  let conversation = noteStreamedTextProjection(
    journal,
    [],
    [message('parent', 'The parent so far')]
  )
  let subagentRows = new Map([
    ['child', child],
    ['sibling', rows(message('sib-1', 'Sibling so far', 'sibling'))]
  ])
  const view = { agentId: 'child', open: () => {} }
  const { result, rerender } = renderHook(
    () =>
      useNativeChatSubagentScope({
        view,
        conversation,
        subagentRows,
        roster,
        journalItems: journal,
        journalSubmissions: [],
        latestTurn: null,
        isWorking: true
      }),
    {}
  )
  const { messages, turnRows } = result.current
  vi.mocked(nativeChatSubagentEnding).mockClear()
  for (let window = 1; window <= 20; window++) {
    const next = new Map(subagentRows)
    next.set(
      'sibling',
      rows(message('sib-1', `Sibling so far${' and more'.repeat(window)}`, 'sibling'))
    )
    noteStreamedTextStage(next, subagentRows)
    subagentRows = next
    rerender()
  }
  for (let window = 1; window <= 20; window++) {
    const text = `The parent so far${' and more'.repeat(window)}`
    const nextJournal = [journalRow(text)]
    noteStreamedTextRevision(nextJournal, journal)
    journal = nextJournal
    conversation = noteStreamedTextProjection(journal, [], [message('parent', text)])
    rerender()
  }
  expect(result.current.messages).toBe(messages)
  expect(result.current.turnRows).toBe(turnRows)
  expect(nativeChatSubagentEnding).not.toHaveBeenCalled()

  // The child's own rows changing does rebuild its view.
  const revised = new Map(subagentRows)
  revised.set('child', rows(message('child-1', 'The full answer, revised.', 'child')))
  subagentRows = revised
  rerender()
  expect(result.current.messages).not.toBe(messages)
  expect(nativeChatSubagentEnding).toHaveBeenCalledTimes(1)
})

let blockReads = 0

/** The rows the open subagent's view bar lists its switcher from. */
function barRowsOf(bar: React.ReactNode): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an open view's bar is the view bar element, whose props name its rows.
  return (bar as React.ReactElement<{ subagentRows: unknown }>).props.subagentRows
}

/** A subagent row whose blocks count each read, so a scan of its transcript shows in the count. */
function countedRow(id: string, text: string): NativeChatSubagentRow {
  const blocks = [{ type: 'text' as const, text }]
  const counted = { id, role: 'assistant' as const, timestamp: 1, source: 'transcript' as const }
  Object.defineProperty(counted, 'blocks', {
    enumerable: true,
    get: () => {
      blockReads += 1
      return blocks
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the getter defines `blocks`, completing the message.
  return { message: { ...counted, agentId: 'child' } as NativeChatMessage, turnKey: undefined }
}

/** Rows the open subagent's view reads, and whether its structure and switcher input hold, over
 *  20 windows of its own reply streaming. */
function ownReplyStreaming(rowCount: number) {
  const saved = Array.from({ length: rowCount }, (_, index) =>
    countedRow(`c-${index}`, `Row ${index}`)
  )
  let subagentRows = new Map([['child', saved]])
  const props = () => ({
    view: { agentId: 'child', open: () => {} },
    conversation: [message('parent', 'Started a helper')],
    subagentRows,
    roster: undefined,
    journalItems: [journalRow('Started a helper')],
    journalSubmissions: [],
    latestTurn: null,
    isWorking: true
  })
  const view = props()
  const { result, rerender } = renderHook(() => useNativeChatSubagentScope(view), {})
  const first = result.current
  blockReads = 0
  let text = `Row ${rowCount - 1}`
  for (let window = 1; window <= 20; window++) {
    text += ' more'
    const next = new Map(subagentRows)
    next.set('child', [...saved.slice(0, -1), countedRow(`c-${rowCount - 1}`, text)])
    noteStreamedTextStage(next, subagentRows)
    subagentRows = next
    Object.assign(view, props())
    rerender()
  }
  const current = result.current
  return {
    reads: blockReads,
    structureHolds: projectionBesideStreamedText(current.messages) === first.messages,
    savedHolds: current.turnRows.structureMessages === first.turnRows.structureMessages,
    switcherHolds: barRowsOf(current.bar) === barRowsOf(first.bar),
    drawsNewest: current.messages.at(-1) !== first.messages.at(-1)
  }
}

// Perf contract: while an open subagent's own reply streams, its view reads only the streaming row
// (its ending compares that reply), every stage that reads no reply text keeps the saved rows, and
// the switcher keeps its input, the same at N and 10N rows.
it("reads only the streaming row of an open subagent's view while its own reply streams", () => {
  for (const rowCount of [2_000, 20_000]) {
    const run = ownReplyStreaming(rowCount)
    expect(run.reads).toBeLessThanOrEqual(20)
    expect(run.structureHolds).toBe(true)
    expect(run.savedHolds).toBe(true)
    expect(run.switcherHolds).toBe(true)
    expect(run.drawsNewest).toBe(true)
  }
})
