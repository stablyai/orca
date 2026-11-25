// @vitest-environment happy-dom
// Words stay with their image when a scope is reused, a hold is handed twice, a removal or Undo is
// refused, a message changes during export, another window edits, or the viewer's row unmounts.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import { moveNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-move'
import { nativeChatComposerDraftSaved } from '../../drafts/native-chat-composer-draft-saved'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { registerNativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import {
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import {
  claimHeldNativeChatNotes,
  holdNativeChatNotes,
  readHeldNativeChatNotes,
  resetNativeChatHeldNotesForTests
} from './native-chat-held-notes'
import { createNativeChatNotesStorage } from './native-chat-notes-storage'
import {
  attachNativeChatNotes,
  captureNativeChatNotesSend,
  NativeChatNotesAlreadyAddedError,
  NativeChatNotesTooLargeError,
  settleNativeChatHeldHandOff,
  submitNativeChatNotesIfApproved
} from './native-chat-notes-handoff'
import {
  nativeChatDraftHasEditingImage,
  restoreNativeChatCleanImage,
  takeNativeChatNotedImage
} from './native-chat-chip-notes'
import { useNativeChatNotesKeptOnUnmount } from './use-native-chat-notes-kept-on-unmount'
import type { NativeChatMediaNote } from './native-chat-media-notes'

vi.mock('./native-chat-media-notes-draw', () => ({
  drawNativeChatNotesImage: async () => new Blob(['png'], { type: 'image/png' })
}))

const SCOPE = 'agent-session:c5'
const SOURCE = 'agent-session:c5-source'
const OTHER = 'agent-session:c5-other'
const MEDIA = '/tmp/dashboard.png'
const NOTES_KEY = 'orca.nativeChat.attachmentNotes.v1'
const HELD_KEY = 'orca.nativeChat.heldNotes.v1'
const note = (number: number, text = `Note ${number}`): NativeChatMediaNote => ({
  id: `n${number}-${text}`,
  number,
  text,
  mark: { kind: 'pin', x: 0.5, y: 0.5 }
})
const record = (notes: NativeChatMediaNote[]): NativeChatAttachmentNotes => ({
  mediaName: 'dashboard.png',
  source: { path: MEDIA },
  kind: 'image',
  notes,
  offset: 0
})
const cold = (key: string, scope: string, id: string): unknown =>
  createNativeChatNotesStorage(key, (value) => value).get(`${scope}\u0000${id}`) ?? null
const refuseStorageWrites = () =>
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
const handle = (attach?: NativeChatComposerHandle['attachGeneratedImage']) => ({
  insertAgentReferences: () => false,
  focus: () => true,
  insertTypedText: () => false,
  acceptsText: () => true,
  appendText: () => {},
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false,
  notesBlocked: () => null,
  submit: vi.fn<() => void>(),
  ...(attach ? { attachGeneratedImage: attach } : {})
})

let drafts: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  drafts = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(drafts)
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => vi.restoreAllMocks())

it('a reused source lets go of only the moved draft’s notes, never the new draft’s', async () => {
  appendToNativeChatComposerDraft(SOURCE, { text: '', images: [{ id: 'old', path: '/o.png' }] })
  setNativeChatAttachmentNotes(SOURCE, 'old', record([note(1, 'moved words')]))
  await nativeChatComposerDraftSaved(SOURCE)
  const refused = refuseStorageWrites()
  moveNativeChatComposerDraft(SOURCE, SCOPE)
  await nativeChatComposerDraftSaved(SCOPE)
  // While notes storage still refuses, a new draft takes the source scope, with notes and a hold of
  // its own.
  appendToNativeChatComposerDraft(SOURCE, { text: '', images: [{ id: 'new', path: '/n.png' }] })
  setNativeChatAttachmentNotes(SOURCE, 'new', record([note(1, 'new words')]))
  holdNativeChatNotes(SOURCE, MEDIA, [note(1, 'new hold')])
  await nativeChatComposerDraftSaved(SOURCE)
  // Storage takes writes again; a confirmed write retries the moved notes and releases the source.
  refused.mockRestore()
  updateNativeChatComposerDraft(SCOPE, { text: 'confirm' }, 'immediate')
  await nativeChatComposerDraftSaved(SCOPE)
  await nativeChatComposerDraftSaved(SOURCE)
  expect(cold(NOTES_KEY, SCOPE, 'old')).not.toBeNull()
  expect(cold(NOTES_KEY, SOURCE, 'old')).toBeNull()
  expect(cold(NOTES_KEY, SOURCE, 'new')).not.toBeNull()
  expect(cold(HELD_KEY, SOURCE, MEDIA)).not.toBeNull()
})

it('Send refuses a message whose line breaks or indents changed during export', () => {
  const composer = handle()
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  const box = document.createElement('div')
  box.dataset.nativeChatComposerScope = SCOPE
  root.append(box)
  document.body.append(root)
  registerNativeChatComposerDestination(box, { current: composer }, true, SCOPE)
  appendToNativeChatComposerDraft(SCOPE, { text: 'one\ntwo', images: [] })
  const approved = captureNativeChatNotesSend(
    { current: box },
    { scopeKey: SCOPE, handle: composer }
  )
  updateNativeChatComposerDraft(SCOPE, { text: 'one\n\n  two' }, 'immediate')
  expect(submitNativeChatNotesIfApproved(approved, [], undefined)).toBe(false)
  expect(composer.submit).not.toHaveBeenCalled()
  root.remove()
})

it('a removed marked chip keeps its words saved until the draft without it is saved', async () => {
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'marked', record([note(1, 'keep me')]))
  await nativeChatComposerDraftSaved(SCOPE)
  drafts.refuseWrites = true
  takeNativeChatNotedImage(SCOPE, 'marked', true)
  await nativeChatComposerDraftSaved(SCOPE)
  // The saved draft still holds the image: its words must still be there for it.
  expect(drafts.drafts.get(SCOPE)?.images.map(({ id }) => id)).toEqual(['marked'])
  expect(cold(NOTES_KEY, SCOPE, 'marked')).not.toBeNull()
  drafts.refuseWrites = false
  updateNativeChatComposerDraft(SCOPE, { text: 'saved now' }, 'immediate')
  await nativeChatComposerDraftSaved(SCOPE)
  await vi.waitFor(() => expect(cold(NOTES_KEY, SCOPE, 'marked')).toBeNull())
})

it('a refused removal never erases a newer entry another window wrote meanwhile', () => {
  const parse = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  const a = createNativeChatNotesStorage<number>(HELD_KEY, parse)
  const b = createNativeChatNotesStorage<number>(HELD_KEY, parse)
  a.update((entries) => entries.set('k', 1).has('k'))
  const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
    throw new DOMException('blocked', 'SecurityError')
  })
  expect(a.update((entries) => entries.delete('k'))).toBe(false)
  removeItem.mockRestore()
  b.update((entries) => entries.set('k', 2).has('k'))
  a.update((entries) => entries.set('other', 3).has('other'))
  expect(createNativeChatNotesStorage<number>(HELD_KEY, parse).get('k')).toBe(2)
})

it('a second viewer of the same held notes gives its copy back instead of adding them twice', async () => {
  holdNativeChatNotes(SCOPE, MEDIA, [note(1)])
  const first = claimHeldNativeChatNotes(SCOPE, MEDIA)
  const second = claimHeldNativeChatNotes(SCOPE, MEDIA)
  appendToNativeChatComposerDraft(SCOPE, {
    text: '',
    images: [
      { id: 'copy-1', path: '/1.png' },
      { id: 'copy-2', path: '/2.png' }
    ]
  })
  settleNativeChatHeldHandOff(SCOPE, ['copy-1'], first)
  expect(() => settleNativeChatHeldHandOff(SCOPE, ['copy-2'], second)).toThrow(
    NativeChatNotesAlreadyAddedError
  )
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['copy-1'])
})

it('Undo of a replacement reports failure when the chip can’t be put back durably', () => {
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'old', path: '/o.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'old', record([note(1)]))
  const putBack = takeNativeChatNotedImage(SCOPE, 'old', true)
  // Neither the draft write nor its addition journal can be saved now.
  drafts.refuseWrites = true
  const refused = refuseStorageWrites()
  expect(putBack()).toBe(false)
  refused.mockRestore()
})

it('Undo of Clear keeps the clean image until the marked one is durably back', () => {
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  const notes = record([note(1)])
  setNativeChatAttachmentNotes(SCOPE, 'marked', notes)
  const undo = restoreNativeChatCleanImage(SCOPE, 'marked', notes)
  const clean = readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)
  drafts.refuseWrites = true
  const refused = refuseStorageWrites()
  undo()
  refused.mockRestore()
  // The clean original is still there: undo didn't trade it for a pair that can't be saved.
  expect(readNativeChatComposerDraft(SCOPE).images.some(({ id }) => clean.includes(id))).toBe(true)
})

it('a marked image settled in another draft is taken back, so a retry adds one copy', async () => {
  const attach = vi.fn(async () => {
    appendToNativeChatComposerDraft(OTHER, { text: '', images: [{ id: 'stray', path: '/s.png' }] })
    return 'stray'
  })
  await expect(
    attachNativeChatNotes({
      composer: { scopeKey: SCOPE, handle: handle(attach) },
      mediaName: 'dashboard.png',
      kind: 'image',
      source: { path: MEDIA },
      notes: [note(1)],
      offset: 0,
      frame: async () => ({ image: new Image(), width: 10, height: 10 })
    })
  ).rejects.toThrow()
  expect(readNativeChatComposerDraft(OTHER).images).toEqual([])
  expect(readNativeChatAttachmentNotes(OTHER, 'stray')).toBeNull()
})

it('held notes coming back to a source that grew past 33 megapixels are refused before drawing', async () => {
  const attach = vi.fn(async () => 'never')
  await expect(
    attachNativeChatNotes({
      composer: { scopeKey: SCOPE, handle: handle(attach) },
      mediaName: 'poster.png',
      kind: 'image',
      source: { path: '/poster.png' },
      notes: [note(1)],
      offset: 0,
      frame: async () => ({ image: new Image(), width: 7700, height: 4400 })
    })
  ).rejects.toBeInstanceOf(NativeChatNotesTooLargeError)
  expect(attach).not.toHaveBeenCalled()
})

it('another window editing a marked image holds this window’s Send, until its marker goes stale', () => {
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'img', path: '/i.png' }] })
  const item = `orca.nativeChat.notesEditing.v1:${encodeURIComponent(`${SCOPE}\u0000img`)}`
  localStorage.setItem(item, '4000000000000')
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(true)
  // A marker left by a window that went away long ago.
  localStorage.setItem(item, '1')
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(false)
})

it('a viewer that goes away without closing keeps its new notes for the chat and media', () => {
  const { unmount } = renderHook(() =>
    useNativeChatNotesKeptOnUnmount({
      notes: [note(1, 'typed')],
      keep: true,
      scopeKey: SCOPE,
      mediaKey: MEDIA
    })
  )
  unmount()
  expect(readHeldNativeChatNotes(SCOPE, MEDIA)?.map(({ text }) => text)).toEqual(['typed'])

  const closed = renderHook(() =>
    useNativeChatNotesKeptOnUnmount({
      notes: [note(1, 'sent')],
      keep: true,
      scopeKey: OTHER,
      mediaKey: MEDIA
    })
  )
  act(() => closed.result.current.settle())
  closed.unmount()
  expect(readHeldNativeChatNotes(OTHER, MEDIA)).toBeNull()
})
