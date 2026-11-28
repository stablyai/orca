// @vitest-environment happy-dom
// The viewer's hand-off through its real delivery hook: the marked copy and the numbered notes go
// into the message box as an ordinary image and ordinary text, Send sends them once, and when the
// message box can't take them the viewer says why and offers Discard.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { registerNativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { insertImageReferences } from '../../composer/editor/native-chat-composer-image-references'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import { useNativeChatNotesDelivery } from './use-native-chat-notes-delivery'
import {
  resetNativeChatNotesNoticesForTests,
  showNativeChatNotesNotice,
  useNativeChatNotesNotice
} from './native-chat-notes-notice'
import { scopeListeners } from '../../drafts/native-chat-composer-draft-memory'
import type { NativeChatMediaNote } from './native-chat-media-notes'

vi.mock('./native-chat-media-notes-draw', () => ({
  drawNativeChatNotesImage: async () => new Blob(['png'], { type: 'image/png' })
}))

const SCOPE = 'agent-session:delivery'
const NOTES_TEXT = 'Notes on a.png (numbered marks in the attached image):\n1. look here'
const NOTES: NativeChatMediaNote[] = [
  { id: 'n1', number: 1, text: 'look here', mark: { kind: 'pin', x: 0.5, y: 0.5 } }
]
const LOADED = { size: { width: 10, height: 10 }, image: new Image() }
const noop = (): void => {}
const draft = () => {
  const { text, images } = readNativeChatComposerDraft(SCOPE)
  return { text, ids: images.map(({ id }) => id) }
}

type Handle = NativeChatComposerHandle & {
  submit: Mock<() => void>
  attachGeneratedImage: Mock<(image: Blob) => Promise<string | null>>
}

/** A chat whose message box attaches the marked copy as it does (the image, then its chip), or
 *  takes no image when `attach` says so. */
function chat(
  options: {
    attach?: () => Promise<string | null>
    blocked?: ReturnType<NonNullable<NativeChatComposerHandle['notesBlocked']>>
  } = {}
): { handle: Handle; opener: { current: Element | null } } {
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
    appendText: noop,
    handlePasteEvent: noop,
    pasteFromClipboard: noop,
    contains: () => false,
    notesBlocked: () => options.blocked ?? null,
    submit: vi.fn<() => void>(),
    attachGeneratedImage: vi.fn(
      options.attach ??
        (async () => {
          appendToNativeChatComposerDraft(SCOPE, { images: [{ id: 'marked', path: '/m.png' }] })
          insertImageReferences(SCOPE, null, ['marked'])
          return 'marked'
        })
    )
  }
  registerNativeChatComposerDestination(box, { current: handle }, true, SCOPE)
  return { handle, opener: { current: tile } }
}

function viewer(opener: { current: Element | null }, onOpenChange: (open: boolean) => void) {
  return renderHook(() => {
    const editor = useNativeChatNotesEditor({ notes: NOTES })
    const delivery = useNativeChatNotesDelivery({
      opener,
      loaded: LOADED,
      editor,
      title: 'a.png',
      onOpenChange,
      showPanel: noop,
      onRestored: noop
    })
    return { editor, delivery }
  })
}

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatNotesNoticesForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => {
  document.body.replaceChildren()
})

it('Close puts the marked copy and the numbered notes in the message box, and Undo takes them out', async () => {
  updateNativeChatComposerDraft(SCOPE, { text: 'please check' }, 'immediate')
  const { opener } = chat()
  const onOpenChange = vi.fn()
  const view = viewer(opener, onOpenChange)
  const line = renderHook(() => useNativeChatNotesNotice(SCOPE))
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(draft()).toEqual({
    text: `please check\n\n[Image](orca-image:marked)\n\n${NOTES_TEXT}`,
    ids: ['marked']
  })
  expect(line.result.current?.text).toBe('1 note added to your message')
  act(() => line.result.current?.action?.onClick())
  expect(draft()).toEqual({ text: 'please check', ids: [] })
})

it('Undo is no longer offered once the message changes', async () => {
  const { opener } = chat()
  const view = viewer(opener, vi.fn())
  const line = renderHook(() => useNativeChatNotesNotice(SCOPE))
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(line.result.current).not.toBeNull()
  act(() => {
    updateNativeChatComposerDraft(SCOPE, { text: 'and something typed' }, 'immediate')
  })
  expect(line.result.current).toBeNull()
  expect(draft().ids).toEqual(['marked'])
})

it('Send puts the marked copy and its notes in the message and sends it once', async () => {
  const { handle, opener } = chat()
  const onOpenChange = vi.fn()
  const view = viewer(opener, onOpenChange)
  await act(async () => {
    await view.result.current.delivery.send()
  })
  expect(handle.submit).toHaveBeenCalledTimes(1)
  expect(draft().text).toContain(NOTES_TEXT)
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it('notes sent while their viewer’s row scrolls away are delivered once', async () => {
  let settle: (id: string) => void = noop
  const { handle, opener } = chat({
    attach: () =>
      new Promise<string | null>((resolve) => {
        settle = resolve
      })
  })
  const view = viewer(opener, vi.fn())
  act(() => {
    void view.result.current.delivery.send()
  })
  await vi.waitFor(() => expect(handle.attachGeneratedImage).toHaveBeenCalledTimes(1), {
    timeout: 10_000
  })
  // The message row unmounts mid-Send, taking the viewer with it.
  view.unmount()
  appendToNativeChatComposerDraft(SCOPE, { images: [{ id: 'marked', path: '/m.png' }] })
  settle('marked')
  await vi.waitFor(() => expect(handle.submit).toHaveBeenCalledTimes(1), { timeout: 10_000 })
})

it('Close while the message box holds a command says why, adds nothing, and offers Discard', async () => {
  const { handle, opener } = chat({ blocked: 'command' })
  const onOpenChange = vi.fn()
  const view = viewer(opener, onOpenChange)
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(handle.attachGeneratedImage).not.toHaveBeenCalled()
  expect(draft()).toEqual({ text: '', ids: [] })
  const status = view.result.current.editor.status
  expect(status?.kind === 'error' && status.message).toBe('The box holds a command.')
  act(() => {
    if (status?.kind === 'error') {
      status.discard?.()
    }
  })
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it('a message box that takes no image adds no notes text, keeps the notes here and offers Discard', async () => {
  const { opener } = chat({ attach: async () => null })
  const onOpenChange = vi.fn()
  const view = viewer(opener, onOpenChange)
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(draft()).toEqual({ text: '', ids: [] })
  expect(view.result.current.editor.notes).toHaveLength(1)
  const status = view.result.current.editor.status
  expect(status?.kind === 'error' && Boolean(status.discard)).toBe(true)
})

it('the notes line stops watching the message once it goes, however it goes', async () => {
  const { opener } = chat()
  const view = viewer(opener, vi.fn())
  const watching = (): number => scopeListeners.get(SCOPE)?.size ?? 0
  const idle = watching()
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(watching()).toBe(idle + 1)
  // Another line takes its place (as a later hand-off's does).
  act(() => {
    showNativeChatNotesNotice(SCOPE, { text: 'another line' })
  })
  expect(watching()).toBe(idle)
})

it('typing while the marked image is prepared keeps the typing, and Undo isn’t offered', async () => {
  const { opener } = chat({
    attach: async () => {
      updateNativeChatComposerDraft(SCOPE, { text: 'typed meanwhile' }, 'immediate')
      appendToNativeChatComposerDraft(SCOPE, { images: [{ id: 'marked', path: '/m.png' }] })
      insertImageReferences(SCOPE, null, ['marked'])
      return 'marked'
    }
  })
  const view = viewer(opener, vi.fn())
  const line = renderHook(() => useNativeChatNotesNotice(SCOPE))
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(line.result.current?.text).toBe('1 note added to your message')
  expect(line.result.current?.action).toBeUndefined()
  expect(draft().text.startsWith('typed meanwhile')).toBe(true)
})

it('Close hands the notes to the message box as it is now, after it remounted', async () => {
  const first = chat()
  const view = viewer(first.opener, vi.fn())
  // The message box remounts while the viewer is open: a new element and a new handle.
  const root = first.opener.current?.parentElement
  root?.querySelector('[data-native-chat-composer-scope]')?.remove()
  const box = document.createElement('div')
  box.dataset.nativeChatComposerScope = SCOPE
  root?.prepend(box)
  const remounted: Handle = {
    ...first.handle,
    submit: vi.fn<() => void>(),
    attachGeneratedImage: vi.fn(async () => {
      appendToNativeChatComposerDraft(SCOPE, { images: [{ id: 'marked', path: '/m.png' }] })
      insertImageReferences(SCOPE, null, ['marked'])
      return 'marked'
    })
  }
  registerNativeChatComposerDestination(box, { current: remounted }, true, SCOPE)
  await act(async () => {
    await view.result.current.delivery.close()
  })
  expect(first.handle.attachGeneratedImage).not.toHaveBeenCalled()
  expect(remounted.attachGeneratedImage).toHaveBeenCalledTimes(1)
})

it('notes of a viewer whose message row goes away without Close still reach the message box', async () => {
  const { handle, opener } = chat()
  const view = viewer(opener, vi.fn())
  // The row unmounts (scrolled out, or replaced as output arrives) with the viewer open.
  view.unmount()
  await vi.waitFor(() => expect(handle.attachGeneratedImage).toHaveBeenCalledTimes(1), {
    timeout: 10_000
  })
  await vi.waitFor(() => expect(draft().text).toContain(NOTES_TEXT), { timeout: 10_000 })
  expect(draft().ids).toEqual(['marked'])
})

it('notes of a viewer that goes away while the message box can’t take them say so there', async () => {
  const { handle, opener } = chat({ blocked: 'command' })
  const view = viewer(opener, vi.fn())
  const line = renderHook(() => useNativeChatNotesNotice(SCOPE))
  view.unmount()
  await vi.waitFor(() => expect(line.result.current?.text).toBe('Notes on a.png weren’t added.'))
  expect(handle.attachGeneratedImage).not.toHaveBeenCalled()
})
