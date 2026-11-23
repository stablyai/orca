// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  noteStreamedTextProjection,
  noteStreamedTextRevision,
  noteStreamedTextStage
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
