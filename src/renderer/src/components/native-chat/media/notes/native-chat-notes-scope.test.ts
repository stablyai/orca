// @vitest-environment happy-dom
// Notes stay with their own chat: two unrelated queued edits never show each other's words, and
// after a fork gives one marked image different words in each chat, each chat reads its own, warm
// and cold.
import { beforeEach, expect, it } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { appendToNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { moveNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-move'
import { createNativeChatQueuedEditDraft } from '../../queue/editing/native-chat-queued-edit-draft'
import {
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import { resetNativeChatHeldNotesForTests } from './native-chat-held-notes'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

const withWords = (text: string): NativeChatAttachmentNotes => ({
  mediaName: 'a.png',
  source: { path: '/tmp/a.png' },
  kind: 'image',
  notes: [{ id: 'n1', number: 1, text, mark: { kind: 'pin', x: 0.5, y: 0.5 } }],
  offset: 0
})
const words = (scope: string, id: string): string | undefined =>
  readNativeChatAttachmentNotes(scope, id)?.notes[0]?.text

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})

it('two unrelated queued edits never show notes from anywhere else on their images', () => {
  // A marked image in one chat, with its words under its own id.
  appendToNativeChatComposerDraft('agent-session:one', {
    images: [{ id: 'marked', path: '/tmp/m.png' }]
  })
  setNativeChatAttachmentNotes('agent-session:one', 'marked', withWords('chat one'))
  // Two queued messages in other chats, each image given the same generic id.
  const message: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'image-ref', path: '/tmp/q.png' }]
  }
  const first = createNativeChatQueuedEditDraft(message, 'agent-session:two')
  const second = createNativeChatQueuedEditDraft(message, 'agent-session:three')
  for (const edit of [first, second]) {
    expect(words(edit.scopeKey, 'kept-0')).toBeUndefined()
    expect(words(edit.scopeKey, 'marked')).toBeUndefined()
  }
})

it('after a fork gives a marked image other words in each chat, each chat reads its own, warm and cold', () => {
  appendToNativeChatComposerDraft('agent-session:origin', {
    text: 'look',
    images: [{ id: 'marked', path: '/tmp/m.png' }]
  })
  setNativeChatAttachmentNotes('agent-session:origin', 'marked', withWords('origin words'))
  // The fork moves the draft into the new chat; the origin chat later holds the image again.
  moveNativeChatComposerDraft('agent-session:origin', 'agent-session:fork')
  appendToNativeChatComposerDraft('agent-session:origin', {
    images: [{ id: 'marked', path: '/tmp/m.png' }]
  })
  setNativeChatAttachmentNotes('agent-session:fork', 'marked', withWords('fork words'))
  setNativeChatAttachmentNotes('agent-session:origin', 'marked', withWords('origin again'))
  expect(words('agent-session:fork', 'marked')).toBe('fork words')
  expect(words('agent-session:origin', 'marked')).toBe('origin again')
  resetNativeChatAttachmentNotesForTests()
  expect(words('agent-session:fork', 'marked')).toBe('fork words')
  expect(words('agent-session:origin', 'marked')).toBe('origin again')
})
