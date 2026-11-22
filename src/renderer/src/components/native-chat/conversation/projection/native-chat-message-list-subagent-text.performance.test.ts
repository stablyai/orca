import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  noteStreamedTextProjection,
  noteStreamedTextRevision,
  stageBesideStreamedText
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'

const row = (text: string): AgentJournalRenderItem => ({
  itemId: 'child-reply',
  revision: 1,
  sequence: 2,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

const message = (id: string, text: string, agentId?: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript',
  ...(agentId ? { agentId } : {})
})

// Perf contract: a subagent reply that only streams text leaves the subagent rows that turn diffs
// and opened pull requests scan standing for the rows it revised, so neither rescans history.
it("links a streaming child's rows to the rows it revised, and not across other changes", () => {
  const project = createNativeChatMessageListProjection()
  const rows = [row('The child so far')]
  const first = noteStreamedTextProjection(
    rows,
    [],
    [message('parent', 'Started a helper'), message('child', 'The child so far', 'helper')]
  )
  const base = project(first).subagentRows
  let latest = base
  for (let step = 1; step <= 20; step++) {
    const text = `The child so far${' and more'.repeat(step)}`
    const next = [row(text)]
    noteStreamedTextRevision(next, rows)
    const messages = noteStreamedTextProjection(
      next,
      [],
      [message('parent', 'Started a helper'), message('child', text, 'helper')]
    )
    latest = project(messages).subagentRows
  }
  expect(latest).not.toBe(base)
  expect(stageBesideStreamedText(latest)).toBe(base)

  // A new row is not a text-only revision; its rows stand for themselves.
  const added = project([
    message('parent', 'Started a helper'),
    message('child', 'Done', 'helper'),
    message('child-2', 'Another', 'helper')
  ]).subagentRows
  expect(stageBesideStreamedText(added)).toBe(added)
})
