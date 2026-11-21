import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import {
  noteStreamedTextProjection,
  noteStreamedTextRevision,
  projectionBesideStreamedText
} from './structured-agent-session-streamed-text-rows'

const reply = (text: string): AgentJournalRenderItem => ({
  itemId: 'reply',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

it("gives a projection's consumers the first projection while only a reply's text grows", () => {
  const submissions: never[] = []
  const first = [reply('The reply')]
  const firstMessages = noteStreamedTextProjection(first, [submissions], [{ id: 'reply' }])
  const grown = [reply('The reply, and more of it')]
  noteStreamedTextRevision(grown, first)
  const grownMessages = noteStreamedTextProjection(grown, [submissions], [{ id: 'reply' }])
  expect(projectionBesideStreamedText(grownMessages)).toBe(firstMessages)
  const sent = noteStreamedTextProjection(grown, [[{ id: 'sent' }]], [{ id: 'reply' }])
  expect(projectionBesideStreamedText(sent)).toBe(sent)
})
