// @vitest-environment happy-dom
// Notes kept while a queued message's edit box held a command: they go back to the chat with the
// edit's other additions, and an edit closed without handing anything back leaves none saved.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { nativeChatComposerDraftSaved } from '../../drafts/native-chat-composer-draft-saved'
import { resetMovedNativeChatDraftSweepForTests } from '../../drafts/native-chat-moved-draft-adoption'
// As the app loads it: the draft move installs the moved-draft sweep.
import '../../drafts/native-chat-composer-draft-move'
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
afterEach(() => vi.restoreAllMocks())

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

it('an unchanged Save whose hand-back of kept notes storage refused keeps them, and the next run returns them to the chat', async () => {
  const edit = queued()
  expect(holdNativeChatNotes(edit.scopeKey, '/tmp/shot.png', NOTES)).toBe(true)
  // Only the chat's held-notes write is refused; everything else goes through.
  const chatItem = `${HELD_KEY}:${encodeURIComponent(`${CHAT}\u0000`)}`
  const setItem = Storage.prototype.setItem
  const refused = vi.spyOn(localStorage, 'setItem').mockImplementation(function (key, value) {
    if (key.startsWith(chatItem)) {
      throw new DOMException('full', 'QuotaExceededError')
    }
    setItem.call(localStorage, key, value)
  })
  // Unchanged Save: the message goes as it was, and nothing of the edit comes back as words.
  expect(handBackNativeChatQueuedEdit(edit)).toBe(false)
  discardNativeChatQueuedEdit(edit)
  expect(readNativeChatComposerDraft(CHAT).text).toBe('')
  // The only saved copy is the edit's own.
  expect(savedHeldScopes()).toEqual([edit.scopeKey])
  refused.mockRestore()
  // The app restarts: the next run hands the kept notes to the chat.
  clearNativeChatComposerDraftsForTests()
  resetNativeChatHeldNotesForTests()
  resetMovedNativeChatDraftSweepForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  updateNativeChatComposerDraft('agent-session:elsewhere', { text: 'x' }, 'immediate')
  await nativeChatComposerDraftSaved('agent-session:elsewhere')
  await vi.waitFor(() => expect(savedHeldScopes()).toEqual([CHAT]))
  resetNativeChatHeldNotesForTests()
  expect(readHeldNativeChatNotes(CHAT, '/tmp/shot.png')?.[0]?.text).toBe('kept words')
})
