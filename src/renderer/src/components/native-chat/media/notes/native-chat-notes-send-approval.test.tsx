// @vitest-environment happy-dom
// Viewer Send through its real delivery hook, with the marked copy's chip put in the message box the
// way the message box does it: Send goes ahead whenever only that chip changed the words.
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
import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import { insertImageReferences } from '../../composer/editor/native-chat-composer-image-references'
import { resetNativeChatAttachmentNotesForTests } from './native-chat-attachment-notes'
import { resetNativeChatHeldNotesForTests } from './native-chat-held-notes'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import { useNativeChatNotesDelivery } from './use-native-chat-notes-delivery'
import type { NativeChatMediaNote } from './native-chat-media-notes'

vi.mock('./native-chat-media-notes-draw', () => ({
  drawNativeChatNotesImage: async () => new Blob(['png'], { type: 'image/png' })
}))

const SCOPE = 'agent-session:approval'
const NOTES: NativeChatMediaNote[] = [
  { id: 'n1', number: 1, text: 'look here', mark: { kind: 'pin', x: 0.5, y: 0.5 } }
]
const LOADED = { size: { width: 10, height: 10 }, image: new Image() }
const SOURCE = { path: '/a.png' }
const noop = (): void => {}

/** A message box editor with its caret at the end of the draft, writing to the draft as it types. */
function editorAtEnd(): NativeChatComposerInput {
  const value = readNativeChatComposerDraft(SCOPE).text
  return {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    disabled: false,
    focus: noop,
    select: noop,
    setSelectionRange: noop,
    insertText: (text) => updateNativeChatComposerDraft(SCOPE, { text: value + text }, 'immediate')
  }
}

/** A chat whose message box attaches the marked copy as it does: the image, then its chip. */
function chat(input: () => NativeChatComposerInput | null): {
  submit: Mock<() => void>
  opener: { current: Element | null }
} {
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  const box = document.createElement('div')
  box.dataset.nativeChatComposerScope = SCOPE
  const tile = document.createElement('button')
  root.append(box, tile)
  document.body.append(root)
  const submit = vi.fn<() => void>()
  const handle: NativeChatComposerHandle = {
    insertAgentReferences: () => false,
    focus: () => true,
    insertTypedText: () => false,
    acceptsText: () => true,
    appendText: noop,
    handlePasteEvent: noop,
    pasteFromClipboard: noop,
    contains: () => false,
    notesBlocked: () => null,
    submit,
    attachGeneratedImage: async () => {
      appendToNativeChatComposerDraft(SCOPE, { images: [{ id: 'marked', path: '/m.png' }] })
      insertImageReferences(SCOPE, input(), ['marked'])
      return 'marked'
    }
  }
  registerNativeChatComposerDestination(box, { current: handle }, true, SCOPE)
  return { submit, opener: { current: tile } }
}

async function sendFromViewer(opener: { current: Element | null }): Promise<void> {
  const view = renderHook(() =>
    useNativeChatNotesDelivery({
      opener,
      loaded: LOADED,
      editor: useNativeChatNotesEditor({ notes: NOTES }),
      title: 'a.png',
      source: SOURCE,
      offset: 0,
      initialNotes: undefined,
      onAttached: undefined,
      onOpenChange: noop,
      showPanel: noop,
      onRestored: noop
    })
  )
  await act(async () => {
    await view.result.current.send()
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

it('Send goes ahead when the message ends in a space the chip reused', async () => {
  updateNativeChatComposerDraft(SCOPE, { text: 'please check ' }, 'immediate')
  const { submit, opener } = chat(editorAtEnd)
  await sendFromViewer(opener)
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('please check [Image](orca-image:marked) ')
  expect(submit).toHaveBeenCalledTimes(1)
})

it('Send goes ahead when the message box has no editor and the chip goes after the message', async () => {
  updateNativeChatComposerDraft(SCOPE, { text: 'please check ' }, 'immediate')
  const { submit, opener } = chat(() => null)
  await sendFromViewer(opener)
  expect(readNativeChatComposerDraft(SCOPE).text).toBe('please check\n\n[Image](orca-image:marked)')
  expect(submit).toHaveBeenCalledTimes(1)
})

it('Send stages instead when the words changed while the image was prepared', async () => {
  updateNativeChatComposerDraft(SCOPE, { text: 'please check ' }, 'immediate')
  const { submit, opener } = chat(() => {
    updateNativeChatComposerDraft(SCOPE, { text: 'please check this ' }, 'immediate')
    return editorAtEnd()
  })
  await sendFromViewer(opener)
  expect(submit).not.toHaveBeenCalled()
})
