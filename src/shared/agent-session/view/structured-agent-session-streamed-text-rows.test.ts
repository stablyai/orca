import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import {
  noteStreamedTextDerivation,
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

it('keeps the link through each later stage built from a linked list', () => {
  const fold = (): void => {}
  const first = [reply('The reply')]
  const firstMessages = noteStreamedTextProjection(first, [], [{ id: 'reply' }])
  const firstFolded = noteStreamedTextDerivation(fold, firstMessages, [false], [{ id: 'reply' }])
  const grown = [reply('The reply, and more of it')]
  noteStreamedTextRevision(grown, first)
  const grownMessages = noteStreamedTextProjection(grown, [], [{ id: 'reply' }])
  const grownFolded = noteStreamedTextDerivation(fold, grownMessages, [false], [{ id: 'reply' }])
  expect(projectionBesideStreamedText(grownFolded)).toBe(firstFolded)
  // A stage whose own inputs changed is new structure.
  const regrouped = noteStreamedTextDerivation(fold, grownMessages, [true], [{ id: 'reply' }])
  expect(projectionBesideStreamedText(regrouped)).toBe(regrouped)
})
