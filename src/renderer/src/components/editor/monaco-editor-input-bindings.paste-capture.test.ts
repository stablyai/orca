// @vitest-environment happy-dom
import type { editor } from 'monaco-editor'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import { MONACO_PASTE_MAX_BYTES } from './monaco-large-text-paste'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: () => () => undefined,
  installMonacoEditorFindShortcut: () => () => undefined,
  installEditorAddReviewNoteShortcut: () => () => undefined
}))

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

function mountEditor() {
  const shell = document.createElement('div')
  const container = document.createElement('div')
  const editorInput = document.createElement('textarea')
  const commentInput = document.createElement('textarea')
  container.append(editorInput)
  shell.append(container, commentInput)
  document.body.append(shell)
  let value = 'base'
  // Mirrors Monaco's CopyPasteController, which claims paste on the container during construction.
  container.addEventListener(
    'paste',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      value += event.clipboardData?.getData('text/plain') ?? ''
    },
    { capture: true }
  )
  const editorStub = {
    getModel: () => ({ uri: { toString: () => 'file:///paste.txt' } }),
    getValue: () => value,
    getContainerDomNode: () => container,
    hasTextFocus: () => true,
    addAction: () => ({ dispose: () => undefined })
  }
  const onContentChange = vi.fn()
  const binding = installMonacoEditorInputBindings({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an over-limit paste is rejected after only the methods stubbed above.
    editorInstance: editorStub as unknown as editor.IStandaloneCodeEditor,
    worktreeId: undefined,
    editorContainerRef: { current: shell },
    propsRef: {
      current: {
        relativePath: 'paste.txt',
        language: 'plaintext',
        onSave: vi.fn(),
        onContentChange
      }
    },
    readOnlyRef: { current: false },
    commentPopoverRef: { current: null },
    shouldShowMarkdownAnnotationsRef: { current: false },
    setCommentPopover: vi.fn(),
    setSelectionAnnotationTarget: vi.fn()
  })
  const paste = (target: HTMLElement, text: string): ClipboardEvent => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    target.dispatchEvent(event)
    return event
  }
  return { editorInput, commentInput, binding, paste, getValue: () => value, onContentChange }
}

it('rejects over-limit paste before Monaco container capture handler can claim it', async () => {
  const editorMount = mountEditor()
  editorMount.paste(editorMount.editorInput, 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1))
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Paste is too large.'))
  expect(editorMount.getValue()).toBe('base')
  expect(editorMount.onContentChange).not.toHaveBeenCalled()
  editorMount.binding.disposeInputBindings()
})

it('leaves comment-overlay paste outside the editor route', () => {
  const editorMount = mountEditor()
  const event = editorMount.paste(editorMount.commentInput, 'x'.repeat(MONACO_PASTE_MAX_BYTES + 1))
  expect(event.defaultPrevented).toBe(false)
  editorMount.binding.disposeInputBindings()
})
