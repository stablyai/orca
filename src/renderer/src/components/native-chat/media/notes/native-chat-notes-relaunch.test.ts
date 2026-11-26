// @vitest-environment happy-dom
// After a restart that cut short a launch draft's move (its notes copy was refused), the session's
// marked image still shows its words, and once storage takes them the stranded source retires.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import { nativeChatComposerDraftSaved } from '../../drafts/native-chat-composer-draft-saved'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
// As the app loads them: the draft move installs its release, chips the notes adoption.
import '../../drafts/native-chat-composer-draft-move'
import './native-chat-chip-notes'
import {
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import { resetNativeChatHeldNotesForTests } from './native-chat-held-notes'
import { createNativeChatNotesStorage } from './native-chat-notes-storage'

const SOURCE = 'agent-session:pending-launch'
const SESSION = 'agent-session:session-1'
const NOTES_KEY = 'orca.nativeChat.attachmentNotes.v1'
const NOTES: NativeChatAttachmentNotes = {
  mediaName: 'dashboard.png',
  source: { path: '/tmp/dashboard.png' },
  kind: 'image',
  notes: [{ id: 'n1', number: 1, text: 'the words', mark: { kind: 'pin', x: 0.5, y: 0.5 } }],
  offset: 0
}
const cold = (scope: string): unknown =>
  createNativeChatNotesStorage(NOTES_KEY, (value) => value).get(`${scope}\u0000marked`) ?? null

let drafts: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  drafts = createMemoryNativeChatComposerDraftStorage()
  // What the restart finds: the session's draft saved with the moved image, its notes refused, and
  // the launch draft and its notes still saved under the scope the draft left.
  const image = { id: 'marked', path: '/tmp/marked.png' }
  drafts.drafts.set(SESSION, { text: 'look here', images: [image], savedAt: 2 })
  drafts.drafts.set(SOURCE, { text: 'look here', images: [image], savedAt: 1 })
  localStorage.setItem(
    `${NOTES_KEY}:${encodeURIComponent(`${SOURCE}\u0000marked`)}`,
    JSON.stringify({ t: 1, v: NOTES })
  )
  setNativeChatComposerDraftStorageForTests(drafts)
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => vi.restoreAllMocks())

it('after a restart the session’s marked image shows its words, and the source retires once they are its own', async () => {
  // Storage is still full: the words show, though they can't be saved under the session yet.
  const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('the words')
  await Promise.resolve()
  expect(cold(SESSION)).toBeNull()
  expect(drafts.drafts.has(SOURCE)).toBe(true)
  full.mockRestore()
  // Storage has room again; the next edit of the session's draft adopts them and the source goes.
  updateNativeChatComposerDraft(SESSION, { text: 'look here, please' }, 'immediate')
  await nativeChatComposerDraftSaved(SESSION)
  await vi.waitFor(() => expect(cold(SESSION)).not.toBeNull())
  await nativeChatComposerDraftSaved(SOURCE)
  await vi.waitFor(() => expect(drafts.drafts.has(SOURCE)).toBe(false))
  expect(cold(SOURCE)).toBeNull()
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('the words')
})
