// @vitest-environment happy-dom
// After a restart that cut short a launch draft's move (its notes copy was refused), the session's
// marked image still shows its words, and once storage takes them the stranded source retires.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import { readHeldNativeChatNotes, resetNativeChatHeldNotesForTests } from './native-chat-held-notes'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { installNativeChatDraftRecord } from '../../drafts/native-chat-composer-draft-memory'
import { createNativeChatNotesStorage } from './native-chat-notes-storage'
import { recordMovedNativeChatDraftSource } from '../../drafts/native-chat-moved-draft-direction'
import { resetMovedNativeChatDraftSweepForTests } from '../../drafts/native-chat-moved-draft-adoption'

const SOURCE = 'agent-session:pending-launch'
const SESSION = 'agent-session:session-1'
const NOTES_KEY = 'orca.nativeChat.attachmentNotes.v1'
const HELD_KEY = 'orca.nativeChat.heldNotes.v1'
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
  // Words held for the launch chat's other image, whose copy to the session was refused too.
  localStorage.setItem(
    `${HELD_KEY}:${encodeURIComponent(`${SOURCE}\u0000/tmp/plain.png`)}`,
    JSON.stringify({ t: 1, v: { scopeKey: SOURCE, notes: NOTES.notes, hold: 'hold-1' } })
  )
  // The move saved which draft it left behind before it began.
  recordMovedNativeChatDraftSource(SOURCE, SESSION)
  setNativeChatComposerDraftStorageForTests(drafts)
  resetMovedNativeChatDraftSweepForTests()
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
  // The words held for the launch chat went to the session before the launch draft retired.
  resetNativeChatHeldNotesForTests()
  expect(readHeldNativeChatNotes(SESSION, '/tmp/plain.png')?.[0]?.text).toBe('the words')
  expect(readHeldNativeChatNotes(SOURCE, '/tmp/plain.png')).toBeNull()
})

it('a chip removed before its notes were adopted doesn’t get them back', async () => {
  const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')).not.toBeNull()
  await Promise.resolve()
  updateNativeChatComposerDraft(SESSION, { images: [] }, 'immediate')
  full.mockRestore()
  updateNativeChatComposerDraft(SESSION, { text: 'and on' }, 'immediate')
  await nativeChatComposerDraftSaved(SESSION)
  await Promise.resolve()
  expect(cold(SESSION)).toBeNull()
})

it('with copies of an image’s notes under two scopes, the newer words are read', () => {
  localStorage.setItem(
    `${NOTES_KEY}:${encodeURIComponent('agent-session:later\u0000marked')}`,
    JSON.stringify({ t: 5, v: { ...NOTES, notes: [{ ...NOTES.notes[0], text: 'newer words' }] } })
  )
  resetNativeChatAttachmentNotesForTests()
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('newer words')
})

it('a queued edit reads its message’s notes but never takes them over or retires the message', async () => {
  const edit = 'queued-edit:one'
  // A queued edit's draft lives in memory while its editor is open, holding the message's images.
  installNativeChatDraftRecord(edit, {
    text: '',
    images: [{ id: 'marked', path: '/tmp/m.png' }],
    savedAt: 3
  })
  expect(readNativeChatComposerDraft(edit).images).toHaveLength(1)
  expect(readNativeChatAttachmentNotes(edit, 'marked')?.notes[0]?.text).toBe('the words')
  updateNativeChatComposerDraft(SESSION, { text: 'save' }, 'immediate')
  await nativeChatComposerDraftSaved(SESSION)
  await Promise.resolve()
  expect(cold(edit)).toBeNull()
  // The message it copies is never retired as an older copy of the edit.
  expect(drafts.drafts.has(SESSION)).toBe(true)
  expect(readNativeChatComposerDraft(SESSION).images.map(({ id }) => id)).toEqual(['marked'])
})

it('a launch draft whose words the session doesn’t have is kept, so no words are lost', async () => {
  // The session's words were rewritten; the launch draft still holds its own, and is kept.
  updateNativeChatComposerDraft(SESSION, { text: 'something else altogether' }, 'immediate')
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('the words')
  await nativeChatComposerDraftSaved(SESSION)
  await vi.waitFor(() => expect(cold(SESSION)).not.toBeNull())
  updateNativeChatComposerDraft(SESSION, { text: 'and once more' }, 'immediate')
  await nativeChatComposerDraftSaved(SESSION)
  await Promise.resolve()
  expect(drafts.drafts.get(SOURCE)?.text).toBe('look here')
})

it('a launch draft given newer words after the move is never retired', async () => {
  updateNativeChatComposerDraft(SOURCE, { text: 'look here, and these new words' }, 'immediate')
  await nativeChatComposerDraftSaved(SOURCE)
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('the words')
  await vi.waitFor(() => expect(cold(SESSION)).not.toBeNull())
  updateNativeChatComposerDraft(SESSION, { text: 'look here' }, 'immediate')
  await nativeChatComposerDraftSaved(SESSION)
  await Promise.resolve()
  expect(drafts.drafts.get(SOURCE)?.text).toBe('look here, and these new words')
})

it('a leftover saved after the session’s draft (a clock stepped back) never retires the session’s draft', async () => {
  // What the restart finds when the clock stepped back between the move's two writes: the launch
  // draft the move left behind looks newer than the session's draft it moved into.
  clearNativeChatComposerDraftsForTests()
  const image = { id: 'marked', path: '/tmp/marked.png' }
  drafts.drafts.set(SESSION, { text: 'look here', images: [image], savedAt: 1 })
  drafts.drafts.set(SOURCE, { text: 'look here', images: [image], savedAt: 2 })
  setNativeChatComposerDraftStorageForTests(drafts)
  resetMovedNativeChatDraftSweepForTests()
  await hydrateNativeChatComposerDrafts()
  // Any saved edit runs the once-per-run sweep of leftovers.
  updateNativeChatComposerDraft('agent-session:elsewhere', { text: 'x' }, 'immediate')
  await nativeChatComposerDraftSaved('agent-session:elsewhere')
  await Promise.resolve()
  expect(readNativeChatComposerDraft(SOURCE).images).toHaveLength(1)
  // The session's draft, the one its chat shows, is never taken for the leftover.
  expect(drafts.drafts.get(SESSION)?.text).toBe('look here')
  expect(readNativeChatComposerDraft(SESSION).images.map(({ id }) => id)).toEqual(['marked'])
})

it('while the session’s copy of the notes is refused, the sweep never retires the launch draft holding the only saved one', async () => {
  // No held words in this case: they would keep the launch draft for their own reason.
  localStorage.removeItem(`${HELD_KEY}:${encodeURIComponent(`${SOURCE}\u0000/tmp/plain.png`)}`)
  resetNativeChatHeldNotesForTests()
  // Storage takes no writes; removing an item still goes through, as it does when storage is full.
  const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  try {
    // The session's marked image shows its words, and adopting them under the session is refused.
    expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('the words')
    await Promise.resolve()
    // Any saved edit runs the once-per-run sweep of leftovers.
    updateNativeChatComposerDraft('agent-session:elsewhere', { text: 'x' }, 'immediate')
    await nativeChatComposerDraftSaved('agent-session:elsewhere')
    await Promise.resolve()
    // The launch draft keeps the only saved copy of the words.
    expect(cold(SESSION)).toBeNull()
    expect(cold(SOURCE)).not.toBeNull()
    expect(drafts.drafts.has(SOURCE)).toBe(true)
  } finally {
    full.mockRestore()
  }
  // Reopened cold, the session's marked image still shows the exact words.
  resetNativeChatAttachmentNotesForTests()
  expect(readNativeChatAttachmentNotes(SESSION, 'marked')?.notes[0]?.text).toBe('the words')
})

it('a session entry with older words under the same image never lets the launch draft retire', async () => {
  localStorage.removeItem(`${HELD_KEY}:${encodeURIComponent(`${SOURCE}\u0000/tmp/plain.png`)}`)
  resetNativeChatHeldNotesForTests()
  // The session saved older words for this image before; the launch draft holds the newer ones.
  localStorage.setItem(
    `${NOTES_KEY}:${encodeURIComponent(`${SESSION}\u0000marked`)}`,
    JSON.stringify({ t: 0, v: { ...NOTES, notes: [{ ...NOTES.notes[0], text: 'older words' }] } })
  )
  resetNativeChatAttachmentNotesForTests()
  updateNativeChatComposerDraft('agent-session:elsewhere', { text: 'x' }, 'immediate')
  await nativeChatComposerDraftSaved('agent-session:elsewhere')
  await Promise.resolve()
  // The newer words stay saved with the launch draft that holds them.
  expect(drafts.drafts.has(SOURCE)).toBe(true)
  resetNativeChatAttachmentNotesForTests()
  expect(
    createNativeChatNotesStorage(NOTES_KEY, (value) => value).get(`${SOURCE}\u0000marked`)
  ).toEqual(NOTES)
})
