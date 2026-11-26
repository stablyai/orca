// @vitest-environment happy-dom
// Notes kept while a queued message's edit box held a command: they go back to the chat with the
// edit's other additions, and an edit closed without handing anything back leaves none saved.
import { beforeEach, expect, it } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit
} from '../../queue/editing/native-chat-queued-edit-draft'
import {
  holdNativeChatNotes,
  readHeldNativeChatNotes,
  resetNativeChatHeldNotesForTests
} from './native-chat-held-notes'
import type { NativeChatMediaNote } from './native-chat-media-notes'

const CHAT = 'agent-session:queued'
const HELD_KEY = 'orca.nativeChat.heldNotes.v1'
const NOTES: NativeChatMediaNote[] = [
  { id: 'n1', number: 1, text: 'kept words', mark: { kind: 'pin', x: 0.5, y: 0.5 } }
]
const queued = () =>
  createNativeChatQueuedEditDraft(
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued text' }] },
    CHAT
  )
const savedHeldScopes = (): string[] =>
  Object.keys(localStorage)
    .filter((item) => item.startsWith(`${HELD_KEY}:`))
    .map((item) => decodeURIComponent(item.slice(HELD_KEY.length + 1)).split('\u0000')[0] ?? '')

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatHeldNotesForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})

it('a cancelled queued edit leaves no notes saved under its scope', () => {
  const edit = queued()
  expect(holdNativeChatNotes(edit.scopeKey, '/tmp/shot.png', NOTES)).toBe(true)
  expect(savedHeldScopes()).toEqual([edit.scopeKey])
  discardNativeChatQueuedEdit(edit)
  expect(savedHeldScopes()).toEqual([])
})

it('a queued edit handed back takes its kept notes to the chat’s own draft', () => {
  const edit = queued()
  holdNativeChatNotes(edit.scopeKey, '/tmp/shot.png', NOTES)
  handBackNativeChatQueuedEdit(edit, true)
  discardNativeChatQueuedEdit(edit)
  expect(savedHeldScopes()).toEqual([CHAT])
  resetNativeChatHeldNotesForTests()
  expect(readHeldNativeChatNotes(CHAT, '/tmp/shot.png')?.[0]?.text).toBe('kept words')
})
