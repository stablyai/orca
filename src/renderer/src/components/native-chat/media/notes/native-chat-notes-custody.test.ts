// @vitest-environment happy-dom
// Notes and their image stay recoverable together through draft moves, held-note hand-offs, Send,
// export-time editing, image-rejecting message boxes, other windows and a reordered image set.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
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
  clearNativeChatAttachmentNotes,
  clearNativeChatImagesKeepingNoted,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import {
  claimHeldNativeChatNotes,
  holdNativeChatNotes,
  readHeldNativeChatNotes,
  releaseHeldNativeChatNotes,
  handOffHeldNativeChatNotes,
  resetNativeChatHeldNotesForTests
} from './native-chat-held-notes'
import { createNativeChatNotesStorage } from './native-chat-notes-storage'
import {
  announceNativeChatNotesHandOff,
  captureNativeChatNotesSend,
  submitNativeChatNotesIfApproved
} from './native-chat-notes-handoff'
import {
  resetNativeChatNotesNoticesForTests,
  useNativeChatNotesNotice
} from './native-chat-notes-notice'
import { clearNativeChatComposerImagesExcept } from '../../attachments/chips/native-chat-composer-images-clear'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import {
  markNativeChatNotedImageEditing,
  nativeChatDraftHasEditingImage
} from './native-chat-chip-notes'
import {
  markNativeChatImageOnlyPending,
  useNativeChatImageOnlyResolve
} from '../../attachments/chips/use-native-chat-image-only-resolve'
import {
  nativeChatCapturedImageIndex,
  useNativeChatFollowedImage
} from '../images/native-chat-captured-image'
import type { NativeChatPendingAttachmentChips } from '../../attachments/intake/native-chat-session-attachment-drop'
import type { NativeChatMediaNote } from './native-chat-media-notes'

const SCOPE = 'agent-session:custody'
const SOURCE = 'agent-session:custody-source'
const NOTES_KEY = 'orca.nativeChat.attachmentNotes.v1'
const note = (number: number, text = `Note ${number}`): NativeChatMediaNote => ({
  id: `n${number}`,
  number,
  text,
  mark: { kind: 'pin', x: 0.5, y: 0.5 }
})
const record = (notes: NativeChatMediaNote[]): NativeChatAttachmentNotes => ({
  mediaName: 'dashboard.png',
  source: { path: '/tmp/dashboard.png' },
  kind: 'image',
  notes,
  offset: 0
})
/** What a restart finds: a fresh read of the notes storage. */
const coldNotes = (scope: string, id: string): unknown =>
  createNativeChatNotesStorage(NOTES_KEY, (value) => value).get(`${scope}\u0000${id}`) ?? null
const refuseNotesWrites = () =>
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })

let drafts: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  resetNativeChatNotesNoticesForTests()
  drafts = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(drafts)
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => vi.restoreAllMocks())

it('a moved draft’s source stays saved, with its notes, until the notes copied to the destination are saved', async () => {
  appendToNativeChatComposerDraft(SOURCE, {
    text: '',
    images: [{ id: 'img-1', path: '/tmp/marked.png' }]
  })
  setNativeChatAttachmentNotes(SOURCE, 'img-1', record([note(1)]))
  await nativeChatComposerDraftSaved(SOURCE)

  const refused = refuseNotesWrites()
  moveNativeChatComposerDraft(SOURCE, SCOPE)
  await nativeChatComposerDraftSaved(SCOPE)
  await nativeChatComposerDraftSaved(SOURCE)
  // The destination's draft is saved, but its notes are not: a restart recovers the source whole.
  expect(drafts.drafts.has(SCOPE)).toBe(true)
  expect(drafts.drafts.get(SOURCE)?.images.map(({ id }) => id)).toEqual(['img-1'])
  expect(coldNotes(SOURCE, 'img-1')).not.toBeNull()
  expect(coldNotes(SCOPE, 'img-1')).toBeNull()

  // Storage takes writes again; the next confirmed destination write retires the source.
  refused.mockRestore()
  updateNativeChatComposerDraft(SCOPE, { text: 'and this' }, 'immediate')
  await nativeChatComposerDraftSaved(SCOPE)
  await nativeChatComposerDraftSaved(SOURCE)
  expect(drafts.drafts.has(SOURCE)).toBe(false)
  expect(coldNotes(SCOPE, 'img-1')).not.toBeNull()
  expect(coldNotes(SOURCE, 'img-1')).toBeNull()
})

it('a moved draft’s source keeps its notes while its own removal is refused', async () => {
  appendToNativeChatComposerDraft(SOURCE, {
    text: '',
    images: [{ id: 'img-1', path: '/tmp/marked.png' }]
  })
  setNativeChatAttachmentNotes(SOURCE, 'img-1', record([note(1)]))
  await nativeChatComposerDraftSaved(SOURCE)
  drafts.remove = () => Promise.reject(new DOMException('refused', 'QuotaExceededError'))
  moveNativeChatComposerDraft(SOURCE, SCOPE)
  await nativeChatComposerDraftSaved(SCOPE)
  await nativeChatComposerDraftSaved(SOURCE)
  // The source's draft is still on disk, so its words must be too.
  expect(drafts.drafts.has(SOURCE)).toBe(true)
  expect(coldNotes(SOURCE, 'img-1')).not.toBeNull()
  expect(coldNotes(SCOPE, 'img-1')).not.toBeNull()
})

it('two windows changing different notes at once keep both changes', () => {
  const a = createNativeChatNotesStorage<number>(NOTES_KEY, (value) =>
    typeof value === 'number' ? value : null
  )
  const b = createNativeChatNotesStorage<number>(NOTES_KEY, (value) =>
    typeof value === 'number' ? value : null
  )
  a.update((entries) => entries.set('x', 1).has('x'))
  const before = new Map<string, string>()
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key !== null) {
      before.set(key, localStorage.getItem(key) ?? '')
    }
  }
  a.update((entries) => entries.set('a', 1).has('a'))
  // Window B still sees storage as it was before A's write landed.
  const getItem = vi
    .spyOn(localStorage, 'getItem')
    .mockImplementation((key) => before.get(key) ?? null)
  b.update((entries) => entries.set('b', 2).delete('x'))
  getItem.mockRestore()
  const cold = createNativeChatNotesStorage<number>(NOTES_KEY, (value) =>
    typeof value === 'number' ? value : null
  )
  expect(cold.keys().sort()).toEqual(['a', 'b'])
})

it('a change storage refused keeps winning for its entry until it lands', () => {
  const parse = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  const a = createNativeChatNotesStorage<number>(NOTES_KEY, parse)
  const b = createNativeChatNotesStorage<number>(NOTES_KEY, parse)
  const refused = refuseNotesWrites()
  expect(a.update((entries) => entries.set('k', 1).has('k'))).toBe(false)
  refused.mockRestore()
  b.update((entries) => entries.set('k', 2).has('k'))
  // A's next write retries its refused change first.
  expect(a.update((entries) => entries.set('other', 3).has('other'))).toBe(true)
  expect(createNativeChatNotesStorage<number>(NOTES_KEY, parse).get('k')).toBe(1)
})

it('a viewer ends only the hold it read, never a newer one held from another viewer', () => {
  holdNativeChatNotes(SCOPE, '/tmp/dashboard.png', [note(1)])
  const older = claimHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')
  holdNativeChatNotes(SCOPE, '/tmp/dashboard.png', [note(1), note(2)])
  releaseHeldNativeChatNotes(older)
  expect(readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')).toHaveLength(2)
  releaseHeldNativeChatNotes(claimHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png'))
  expect(readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')).toBeNull()
})

const MEDIA = '/tmp/dashboard.png'
const rawHeld = (): unknown =>
  createNativeChatNotesStorage('orca.nativeChat.heldNotes.v1', (value) => value).get(
    `${SCOPE}\u0000${MEDIA}`
  ) ?? null

it('held notes handed off while the draft save is refused are never offered twice, and end at the next save', async () => {
  holdNativeChatNotes(SCOPE, MEDIA, [note(1)])
  const claim = claimHeldNativeChatNotes(SCOPE, MEDIA)
  drafts.refuseWrites = true
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'marked', record([note(1)]))
  expect(await handOffHeldNativeChatNotes(claim, ['marked'])).toBe(false)
  // While the draft holds the marked image, reopening the media offers no second copy, also after a
  // restart; the hold itself stays saved in case the draft lost the image.
  resetNativeChatHeldNotesForTests()
  expect(readHeldNativeChatNotes(SCOPE, MEDIA)).toBeNull()
  expect(rawHeld()).not.toBeNull()
  // The next ordinary save of the draft ends the hold, with nothing calling it again.
  drafts.refuseWrites = false
  updateNativeChatComposerDraft(SCOPE, { text: 'retry' }, 'immediate')
  await vi.waitFor(() => expect(rawHeld()).toBeNull())
})

it('a hold handed to a marked image ends when that image is sent, so it never comes back', async () => {
  holdNativeChatNotes(SCOPE, MEDIA, [note(1)])
  const claim = claimHeldNativeChatNotes(SCOPE, MEDIA)
  drafts.refuseWrites = true
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  await handOffHeldNativeChatNotes(claim, ['marked'])
  // Sent: the image and its notes leave the draft.
  updateNativeChatComposerDraft(SCOPE, { images: [] }, 'immediate')
  clearNativeChatAttachmentNotes(SCOPE, ['marked'])
  resetNativeChatHeldNotesForTests()
  expect(readHeldNativeChatNotes(SCOPE, MEDIA)).toBeNull()
  expect(rawHeld()).toBeNull()
})

it('a reused source keeps its copy of the words while the destination’s copy is still refused', async () => {
  appendToNativeChatComposerDraft(SOURCE, { text: '', images: [{ id: 'img-1', path: '/m.png' }] })
  setNativeChatAttachmentNotes(SOURCE, 'img-1', record([note(1, 'the words')]))
  await nativeChatComposerDraftSaved(SOURCE)
  const refused = refuseNotesWrites()
  moveNativeChatComposerDraft(SOURCE, SCOPE)
  await nativeChatComposerDraftSaved(SCOPE)
  // The source scope takes a new draft before the destination's notes were saved.
  refused.mockRestore()
  const again = refuseNotesWrites()
  appendToNativeChatComposerDraft(SOURCE, { text: 'something new', images: [] })
  await nativeChatComposerDraftSaved(SOURCE)
  expect(coldNotes(SOURCE, 'img-1')).not.toBeNull()
  // Once the destination's copy lands, the source's goes.
  again.mockRestore()
  updateNativeChatComposerDraft(SCOPE, { text: 'and now' }, 'immediate')
  await nativeChatComposerDraftSaved(SCOPE)
  expect(coldNotes(SCOPE, 'img-1')).not.toBeNull()
  expect(coldNotes(SOURCE, 'img-1')).toBeNull()
})

it('a draft that moves on again before its first move settled keeps its first source until the last destination is saved', async () => {
  const MIDDLE = 'agent-session:custody-middle'
  appendToNativeChatComposerDraft(SOURCE, { text: 'words', images: [] })
  await nativeChatComposerDraftSaved(SOURCE)
  const write = drafts.write
  drafts.write = (scope, draft) =>
    scope === SCOPE
      ? Promise.reject(new DOMException('refused', 'QuotaExceededError'))
      : write(scope, draft)
  moveNativeChatComposerDraft(SOURCE, MIDDLE)
  moveNativeChatComposerDraft(MIDDLE, SCOPE)
  await nativeChatComposerDraftSaved(MIDDLE)
  await nativeChatComposerDraftSaved(SCOPE)
  await nativeChatComposerDraftSaved(SOURCE)
  // The last destination refused its write: the first source is still the saved copy.
  expect(drafts.drafts.get(SOURCE)?.text).toBe('words')
  drafts.write = write
  updateNativeChatComposerDraft(SCOPE, { text: 'words!' }, 'immediate')
  await nativeChatComposerDraftSaved(SCOPE)
  await nativeChatComposerDraftSaved(SOURCE)
  expect(drafts.drafts.has(SOURCE)).toBe(false)
})

it('a terminal command keeps marked images in every write of the draft', async () => {
  appendToNativeChatComposerDraft(SCOPE, {
    text: '/compact',
    images: [
      { id: 'marked', path: '/m.png' },
      { id: 'plain', path: '/p.png' }
    ]
  })
  setNativeChatAttachmentNotes(SCOPE, 'marked', record([note(1)]))
  await nativeChatComposerDraftSaved(SCOPE)
  const written: string[][] = []
  const write = drafts.write
  drafts.write = (scope, draft) => {
    written.push(draft.images.map(({ id }) => id))
    return write(scope, draft)
  }
  // As the message box clears a command's images.
  clearNativeChatImagesKeepingNoted(SCOPE, (keep) =>
    clearNativeChatComposerImagesExcept(SCOPE, keep)
  )
  await nativeChatComposerDraftSaved(SCOPE)
  expect(written.length).toBeGreaterThan(0)
  expect(written.every((ids) => ids.includes('marked'))).toBe(true)
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['marked'])
})

it('Undo puts back what the notes replaced before taking the new pair out, and keeps it when that fails', async () => {
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'marked', record([note(1)]))
  announceNativeChatNotesHandOff(SCOPE, ['marked'], () => false, 1)
  const { result } = renderHook(() => useNativeChatNotesNotice(SCOPE))
  act(() => result.current?.action?.onClick())
  // The earlier state couldn't be saved: the new pair stays, with its words.
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['marked'])
  announceNativeChatNotesHandOff(SCOPE, ['marked'], () => true, 1)
  const { result: second } = renderHook(() => useNativeChatNotesNotice(SCOPE))
  act(() => second.current?.action?.onClick())
  expect(readNativeChatComposerDraft(SCOPE).images).toEqual([])
})

it('Send counts the editor’s own image tokens as part of the hand-off, not a changed draft', () => {
  const handle = composerHandle()
  const chat = chatWithComposer(handle)
  appendToNativeChatComposerDraft(SCOPE, {
    text: 'look at [Image](orca-image:chip) ',
    images: [{ id: 'chip', path: '/a.png' }]
  })
  const approved = captureNativeChatNotesSend(chat.opener, { scopeKey: SCOPE, handle })
  // The structured editor swaps the chip's token for the marked copy's.
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  updateNativeChatComposerDraft(
    SCOPE,
    {
      text: 'look at [Image](orca-image:marked) ',
      images: readNativeChatComposerDraft(SCOPE).images.filter(({ id }) => id !== 'chip')
    },
    'immediate'
  )
  expect(submitNativeChatNotesIfApproved(approved, ['marked'], 'chip')).toBe(true)
  expect(handle.submit).toHaveBeenCalledTimes(1)
})

it('the viewer follows the open image when the message’s images reorder', () => {
  const image = (path: string) => ({ type: 'image-ref' as const, path })
  const { result, rerender } = renderHook(({ images }) => useNativeChatFollowedImage(images), {
    initialProps: { images: [image('/a.png'), image('/b.png')] }
  })
  act(() => result.current[1](1))
  expect(result.current[0]).toBe(1)
  rerender({ images: [image('/b.png'), image('/a.png')] })
  expect(result.current[0]).toBe(0)
  // The same picture twice: it stays where it was rather than jump to the other copy.
  rerender({ images: [image('/b.png'), image('/b.png')] })
  expect(result.current[0]).toBe(0)
  rerender({ images: [image('/c.png')] })
  expect(result.current[0]).toBeNull()
})

function chatWithComposer(handle: NativeChatComposerHandle): {
  opener: { current: Element | null }
  remount: (next: NativeChatComposerHandle) => void
} {
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  const box = document.createElement('div')
  box.dataset.nativeChatComposerScope = SCOPE
  const chip = document.createElement('button')
  root.append(box, chip)
  document.body.append(root)
  let unregister = registerNativeChatComposerDestination(box, { current: handle }, true, SCOPE)
  return {
    opener: { current: chip },
    remount: (next) => {
      unregister()
      unregister = registerNativeChatComposerDestination(box, { current: next }, true, SCOPE)
    }
  }
}

const composerHandle = (): NativeChatComposerHandle & { submit: Mock<() => void> } => ({
  insertAgentReferences: () => false,
  focus: () => true,
  insertTypedText: () => false,
  acceptsText: () => true,
  appendText: () => {},
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false,
  notesBlocked: () => null,
  submit: vi.fn<() => void>()
})

it('Send submits once, only to the message box and draft it was pressed for', () => {
  const handle = composerHandle()
  const chat = chatWithComposer(handle)
  appendToNativeChatComposerDraft(SCOPE, { text: 'look', images: [{ id: 'chip', path: '/a.png' }] })
  const approved = captureNativeChatNotesSend(chat.opener, { scopeKey: SCOPE, handle })
  // The marked copy replaces the chip; the chip (the opener) leaves the page.
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  updateNativeChatComposerDraft(
    SCOPE,
    { images: readNativeChatComposerDraft(SCOPE).images.filter(({ id }) => id !== 'chip') },
    'immediate'
  )
  chat.opener.current?.remove()
  expect(submitNativeChatNotesIfApproved(approved, ['marked'], 'chip')).toBe(true)
  expect(handle.submit).toHaveBeenCalledTimes(1)

  // The draft changed during export: nothing is sent; the marked image stays in the box.
  const again = captureNativeChatNotesSend(
    { current: document.body.lastElementChild },
    {
      scopeKey: SCOPE,
      handle
    }
  )
  updateNativeChatComposerDraft(SCOPE, { text: 'look, and more' }, 'immediate')
  expect(submitNativeChatNotesIfApproved(again, [], undefined)).toBe(false)

  // The message box was replaced by another instance meanwhile.
  const third = captureNativeChatNotesSend(
    { current: document.body.lastElementChild },
    {
      scopeKey: SCOPE,
      handle
    }
  )
  chat.remount(composerHandle())
  expect(submitNativeChatNotesIfApproved(third, [], undefined)).toBe(false)
  expect(handle.submit).toHaveBeenCalledTimes(1)
})

it('a note open in the editor can’t be typed into while Send makes the marked image', () => {
  const { result } = renderHook(() => useNativeChatNotesEditor({ notes: [note(1, 'before')] }))
  act(() => {
    result.current.open('n1')
  })
  act(() => {
    result.current.setLocked(true)
  })
  act(() => {
    result.current.setDraftText('typed during export')
  })
  expect(result.current.draftText).toBe('before')
  act(() => {
    result.current.setLocked(false)
    result.current.setDraftText('after')
  })
  expect(result.current.draftText).toBe('after')
})

it('a marked notes image is dropped, not kept as a file reference, by a box that takes no images', () => {
  const resolve = vi.fn<NativeChatPendingAttachmentChips['resolve']>(() => true)
  const drop = vi.fn(() => true)
  const { result } = renderHook(() =>
    useNativeChatImageOnlyResolve(resolve, drop, { acceptsImages: false })
  )
  markNativeChatImageOnlyPending('generated-1')
  expect(result.current('generated-1', '/tmp/m.png')).toBe(false)
  expect(drop).toHaveBeenCalledWith('generated-1')
  expect(resolve).not.toHaveBeenCalled()
  // An ordinary paste still becomes a file reference there.
  result.current('pasted-1', '/tmp/p.png')
  expect(resolve).toHaveBeenCalledWith('pasted-1', '/tmp/p.png', undefined, undefined)
})

it('Annotate opens the captured image even after the message’s images reorder', () => {
  const image = (path: string) => ({ type: 'image-ref' as const, path })
  const captured = image('/b.png')
  expect(nativeChatCapturedImageIndex([image('/b.png'), image('/a.png')], captured)).toBe(0)
  expect(nativeChatCapturedImageIndex([image('/a.png'), image('/c.png')], captured)).toBe(-1)
  // Two images with the same source can't be told apart: refuse rather than guess.
  expect(nativeChatCapturedImageIndex([image('/b.png'), image('/b.png')], captured)).toBe(-1)
})

it('a marked image stays out of Send while any viewer still edits it', () => {
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'img-1', path: '/a.png' }] })
  const first = markNativeChatNotedImageEditing(SCOPE, 'img-1')
  const second = markNativeChatNotedImageEditing(SCOPE, 'img-1')
  first()
  first()
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(true)
  second()
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(false)
})
