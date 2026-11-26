// @vitest-environment happy-dom
// The viewer's hand-off through its real delivery hook: a viewer that goes away while Send is under
// way, and a reopened chip that another viewer also has open.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { registerNativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import {
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import { useNativeChatNotesNotice } from './native-chat-notes-notice'
import { readHeldNativeChatNotes, resetNativeChatHeldNotesForTests } from './native-chat-held-notes'
import {
  markNativeChatNotedImageEditing,
  replaceNativeChatNotedImage
} from './native-chat-chip-notes'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import { useNativeChatNotesDelivery } from './use-native-chat-notes-delivery'
import type { NativeChatMediaNote } from './native-chat-media-notes'

vi.mock('./native-chat-media-notes-draw', () => ({
  drawNativeChatNotesImage: async () => new Blob(['png'], { type: 'image/png' })
}))

const SCOPE = 'agent-session:delivery'
const note = (number: number, text = `Note ${number}`): NativeChatMediaNote => ({
  id: `n${number}`,
  number,
  text,
  mark: { kind: 'pin', x: 0.5, y: 0.5 }
})

type Handle = NativeChatComposerHandle & {
  submit: Mock<() => void>
  attachGeneratedImage: Mock<(image: Blob) => Promise<string | null>>
}

function chat(attach: (image: Blob) => Promise<string | null>): {
  handle: Handle
  opener: { current: Element | null }
} {
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  const box = document.createElement('div')
  box.dataset.nativeChatComposerScope = SCOPE
  const tile = document.createElement('button')
  root.append(box, tile)
  document.body.append(root)
  const handle: Handle = {
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
    attachGeneratedImage: vi.fn(attach)
  }
  registerNativeChatComposerDestination(box, { current: handle }, true, SCOPE)
  return { handle, opener: { current: tile } }
}

function viewer(args: {
  opener: { current: Element | null }
  notes: NativeChatMediaNote[]
  initialNotes?: NativeChatMediaNote[]
  onAttached?: () => (() => boolean) | false
  replacesAttachmentId?: string
  onOpenChange: (open: boolean) => void
}) {
  // Stable across renders, as the viewer's own are.
  const loaded = { size: { width: 10, height: 10 }, image: new Image() }
  const source = { path: '/a.png' }
  const showPanel = (): void => {}
  const onRestored = (): void => {}
  return renderHook(() => {
    const editor = useNativeChatNotesEditor({ notes: args.notes })
    return useNativeChatNotesDelivery({
      opener: args.opener,
      loaded,
      editor,
      title: 'a.png',
      source,
      offset: 0,
      initialNotes: args.initialNotes,
      onAttached: args.onAttached,
      replacesAttachmentId: args.replacesAttachmentId,
      onOpenChange: args.onOpenChange,
      showPanel,
      onRestored
    })
  })
}

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => {
  document.body.replaceChildren()
})

it('notes sent while their viewer’s row scrolls away are delivered once and never held to send again', async () => {
  let settle: (id: string) => void = () => {}
  const { handle, opener } = chat(
    () =>
      new Promise<string | null>((resolve) => {
        settle = resolve
      })
  )
  const view = viewer({ opener, notes: [note(1, 'look here')], onOpenChange: vi.fn() })
  act(() => {
    void view.result.current.send()
  })
  await vi.waitFor(() => expect(handle.attachGeneratedImage).toHaveBeenCalledTimes(1), {
    timeout: 10_000
  })
  // The message row unmounts mid-Send, taking the viewer with it.
  view.unmount()
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'marked', path: '/m.png' }] })
  settle('marked')
  await vi.waitFor(() => expect(handle.submit).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  // Delivered: nothing kept to reopen the media with, so a later Send can't repeat them.
  expect(readHeldNativeChatNotes(SCOPE, '/a.png')).toBeNull()
})

it('closing one of two viewers of a reopened chip leaves the chip to the other viewer', async () => {
  // Attaching puts the marked copy in the draft, as the message box does.
  const { handle, opener } = chat(async () => {
    appendToNativeChatComposerDraft(SCOPE, {
      text: '',
      images: [{ id: 'marked-copy', path: '/m.png' }]
    })
    return 'marked-copy'
  })
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'chip', path: '/c.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'chip', {
    mediaName: 'a.png',
    source: { path: '/a.png' },
    kind: 'image',
    notes: [note(1)],
    offset: 0
  })
  // Two viewers have the chip open, as their chips mark it.
  const endFirst = markNativeChatNotedImageEditing(SCOPE, 'chip')
  const endSecond = markNativeChatNotedImageEditing(SCOPE, 'chip')
  const onAttached = vi.fn(() => replaceNativeChatNotedImage(SCOPE, 'chip'))
  const onOpenChange = vi.fn()
  // This viewer added a note; closing would replace the chip under the other viewer.
  const changed = viewer({
    opener,
    notes: [note(1), note(2)],
    initialNotes: [note(1)],
    onAttached,
    replacesAttachmentId: 'chip',
    onOpenChange
  })
  await act(async () => {
    await changed.result.current.close()
  })
  expect(handle.attachGeneratedImage).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['chip'])
  // A viewer left as it was closes without exporting anything.
  const unchanged = viewer({
    opener,
    notes: [note(1)],
    initialNotes: [note(1)],
    onAttached,
    replacesAttachmentId: 'chip',
    onOpenChange
  })
  await act(async () => {
    await unchanged.result.current.close()
  })
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(handle.attachGeneratedImage).not.toHaveBeenCalled()
  expect(onAttached).not.toHaveBeenCalled()
  endFirst()
  endSecond()
})

it('a message box that takes no image leaves the notes in the viewer with its error, not stuck', async () => {
  const { handle, opener } = chat(async () => null)
  const onOpenChange = vi.fn()
  const view = viewer({ opener, notes: [note(1, 'keep me')], onOpenChange })
  let closed = false
  await act(async () => {
    await view.result.current.close()
    closed = true
  })
  expect(closed).toBe(true)
  expect(handle.attachGeneratedImage).toHaveBeenCalledTimes(1)
  expect(onOpenChange).not.toHaveBeenCalled()
})

it('a reopened chip whose marked copy can’t be attached keeps the chip and the edited words', async () => {
  const { handle, opener } = chat(async () => null)
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'chip', path: '/c.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'chip', {
    mediaName: 'a.png',
    source: { path: '/a.png' },
    kind: 'image',
    notes: [note(1)],
    offset: 0
  })
  const end = markNativeChatNotedImageEditing(SCOPE, 'chip')
  const onAttached = vi.fn(() => replaceNativeChatNotedImage(SCOPE, 'chip'))
  const onOpenChange = vi.fn()
  const view = viewer({
    opener,
    notes: [note(1), note(2, 'added')],
    initialNotes: [note(1)],
    onAttached,
    replacesAttachmentId: 'chip',
    onOpenChange
  })
  await act(async () => {
    await view.result.current.close()
  })
  expect(handle.attachGeneratedImage).toHaveBeenCalledTimes(1)
  expect(onAttached).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['chip'])
  end()
})

it('clearing every note of a chip another viewer still edits closes, leaving the chip to that viewer', async () => {
  const { handle, opener } = chat(async () => null)
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'chip', path: '/c.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'chip', {
    mediaName: 'a.png',
    source: { path: '/a.png' },
    kind: 'image',
    notes: [note(1)],
    offset: 0
  })
  const endFirst = markNativeChatNotedImageEditing(SCOPE, 'chip')
  const endSecond = markNativeChatNotedImageEditing(SCOPE, 'chip')
  const onCleared = vi.fn(() => () => true)
  const onOpenChange = vi.fn()
  // This viewer removed every note; closing would put the clean image in the chip's place.
  const view = renderHook(() => {
    const editor = useNativeChatNotesEditor({ notes: [] })
    return useNativeChatNotesDelivery({
      opener,
      loaded: CLEAR_LOADED,
      editor,
      title: 'a.png',
      source: CLEAR_SOURCE,
      offset: 0,
      initialNotes: CLEAR_INITIAL,
      onAttached: undefined,
      onCleared,
      replacesAttachmentId: 'chip',
      onOpenChange,
      showPanel: noop,
      onRestored: noop
    })
  })
  const notice = renderHook(() => useNativeChatNotesNotice(SCOPE))
  await act(async () => {
    await view.result.current.close()
  })
  // Close never traps the user in the viewer: it closes, and the chip keeps its notes.
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(onCleared).not.toHaveBeenCalled()
  expect(handle.attachGeneratedImage).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['chip'])
  expect(readNativeChatAttachmentNotes(SCOPE, 'chip')?.notes).toHaveLength(1)
  // The message box says why, as Remove does.
  expect(notice.result.current?.text).toBe('Finish editing elsewhere first.')
  endFirst()
  endSecond()
})

const CLEAR_LOADED = { size: { width: 10, height: 10 }, image: new Image() }
const CLEAR_SOURCE = { path: '/a.png' }
const CLEAR_INITIAL = [note(1)]
const noop = (): void => {}

it('a chip another viewer opens while its marked copy is prepared stays, with both viewers’ words', async () => {
  let endSecond = (): void => {}
  // The second viewer opens the chip while this one's image is being prepared.
  const { handle, opener } = chat(async () => {
    endSecond = markNativeChatNotedImageEditing(SCOPE, 'chip')
    appendToNativeChatComposerDraft(SCOPE, {
      text: '',
      images: [{ id: 'marked-copy', path: '/m.png' }]
    })
    return 'marked-copy'
  })
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'chip', path: '/c.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'chip', {
    mediaName: 'a.png',
    source: { path: '/a.png' },
    kind: 'image',
    notes: [note(1)],
    offset: 0
  })
  const endFirst = markNativeChatNotedImageEditing(SCOPE, 'chip')
  const onAttached = vi.fn(() => replaceNativeChatNotedImage(SCOPE, 'chip'))
  const onOpenChange = vi.fn()
  const view = viewer({
    opener,
    notes: [note(1), note(2, 'mine')],
    initialNotes: [note(1)],
    onAttached,
    replacesAttachmentId: 'chip',
    onOpenChange
  })
  await act(async () => {
    await view.result.current.close()
  })
  expect(handle.attachGeneratedImage).toHaveBeenCalledTimes(1)
  // The chip and its notes stay for the other viewer; this one stays open with its own words.
  expect(onAttached).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual(['chip'])
  expect(readNativeChatAttachmentNotes(SCOPE, 'chip')?.notes).toHaveLength(1)
  endFirst()
  endSecond()
})
