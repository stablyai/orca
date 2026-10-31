// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type * as EditorInstance from './useRichMarkdownEditorInstance'
import RichMarkdownEditor from './RichMarkdownEditor'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installHappyDomSelectionNotificationTasks } from '../../../../../config/scripts/vitest-dom-setup'

const live = vi.hoisted((): { editor: Editor | null } => ({ editor: null }))
vi.mock('./useRichMarkdownEditorInstance', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorInstance>()
  return {
    useRichMarkdownEditorInstance: (
      ...args: Parameters<typeof actual.useRichMarkdownEditorInstance>
    ) => {
      const editor = actual.useRichMarkdownEditorInstance(...args)
      live.editor = editor
      return editor
    }
  }
})

let disposeSelectionNotifications: (() => void) | null = null
beforeEach(() => {
  disposeSelectionNotifications = installHappyDomSelectionNotificationTasks(document)
})
afterEach(() => {
  try {
    cleanup()
  } finally {
    disposeSelectionNotifications?.()
    disposeSelectionNotifications = null
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    live.editor = null
  }
})

it.each(['outside', 'null', 'inside'] as const)(
  'flushes rich-root pending typing only when focus leaves (%s)',
  async (destination) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          setMarkdownEditorFocused: vi.fn(),
          onRichMarkdownContextCommand: () => () => {}
        }
      }
    })
    const onContentChange = vi.fn()
    const view = render(
      <RichMarkdownEditor
        fileId="focus-file"
        viewStateId="focus-view"
        content="base"
        filePath="/repo/focus.md"
        worktreeId="focus-workspace"
        scrollCacheKey="focus-file"
        onContentChange={onContentChange}
        onDirtyStateHint={() => {}}
        onSave={() => {}}
        headerSlot={<input aria-label="inside" />}
      />
    )
    await waitFor(() => {
      const current = live.editor
      if (!current) {
        throw new Error('Editor did not mount')
      }
      expect(current.isInitialized).toBe(true)
      expect(current.view.dom.isConnected).toBe(true)
      expect(view.container.contains(current.view.dom)).toBe(true)
    })
    const editor = live.editor
    const root = view.container.querySelector('.rich-markdown-editor-shell')
    if (!editor || !root) {
      throw new Error('Editor did not mount')
    }
    vi.useFakeTimers()
    act(() => {
      editor.commands.insertContent('typed ')
    })
    expect(onContentChange).not.toHaveBeenCalled()
    const relatedTarget =
      destination === 'inside'
        ? view.getByLabelText('inside')
        : destination === 'outside'
          ? document.body
          : null
    fireEvent.focusOut(root, { relatedTarget })
    if (destination === 'inside') {
      expect(onContentChange).not.toHaveBeenCalled()
    } else {
      expect(onContentChange).toHaveBeenCalledExactlyOnceWith('typed base')
    }
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith('typed base')
  }
)

it.each([
  'Bold',
  'Heading 2',
  'More blocks',
  'Link',
  'Image',
  'Remove link',
  'copy',
  'cut',
  'paste',
  'dragstart'
] as const)('uses the completed native range for the external %s action', async (action) => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const pickImage = vi.fn().mockResolvedValue(null)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        setMarkdownEditorFocused: vi.fn(),
        onRichMarkdownContextCommand: () => () => {}
      },
      shell: { pickImage }
    }
  })
  const view = render(
    <RichMarkdownEditor
      fileId="selection-file"
      viewStateId="selection-view"
      content={
        action === 'Remove link'
          ? '[untouched](https://one.test)\n\n[lower caret](https://two.test)'
          : 'untouched\n\nlower caret'
      }
      filePath="/repo/selection.md"
      worktreeId="selection-workspace"
      scrollCacheKey="selection-file"
      onContentChange={() => {}}
      onDirtyStateHint={() => {}}
      onSave={() => {}}
    />,
    { wrapper: TooltipProvider }
  )
  await act(async () => {})
  const editor = live.editor
  const paragraph = view.container.querySelector('.rich-markdown-editor p:last-child')
  const text = paragraph?.querySelector('a')?.firstChild ?? paragraph?.firstChild
  if (!editor || !paragraph || !text) {
    throw new Error('Expected mounted editor paragraph')
  }
  vi.useFakeTimers()
  act(() => {
    editor.view.focus()
    if (action === 'Remove link') {
      editor.commands.setTextSelection(2)
    }
  })
  const from = editor.view.posAtDOM(text, 6)
  const to = editor.view.posAtDOM(text, 11)
  // Hold only setup notification: the external action must handle undelivered native input itself.
  const holdNotification = (event: Event) => event.stopImmediatePropagation()
  document.addEventListener('selectionchange', holdNotification, true)
  try {
    document.getSelection()?.setBaseAndExtent(text, 11, text, 6)
  } finally {
    document.removeEventListener('selectionchange', holdNotification, true)
  }
  expect(document.getSelection()?.toString()).toBe('caret')
  expect(editor.state.selection.from).not.toBe(from)

  if (action === 'copy' || action === 'cut' || action === 'paste' || action === 'dragstart') {
    const data = new DataTransfer()
    data.setData('text/plain', 'replacement')
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: from, inside: -1 })
    const event =
      action === 'dragstart'
        ? new DragEvent(action, { bubbles: true, cancelable: true, dataTransfer: data })
        : new ClipboardEvent(action, { bubbles: true, cancelable: true, clipboardData: data })
    if (action === 'dragstart') {
      // The DOM emulator aliases DragEvent to Event and drops its dataTransfer initializer.
      Object.defineProperty(event, 'dataTransfer', { value: data })
      if (!(event instanceof DragEvent)) {
        throw new Error('Expected drag event')
      }
      expect(event.dataTransfer).toBe(data)
    }
    fireEvent(editor.view.dom, event)
    if (action === 'paste') {
      expect(editor.view.dom.querySelector('p:last-child')?.textContent).toBe('lower replacement')
    } else {
      expect(data.getData('text/plain')).toBe('caret')
      expect(editor.view.dom.querySelector('p:last-child')?.textContent).toBe(
        action === 'cut' ? 'lower ' : 'lower caret'
      )
    }
    expect(editor.view.dom.querySelector('p')?.textContent).toBe('untouched')
    return
  }

  const button = view.getByRole('button', { name: action })
  expect(fireEvent.mouseDown(button, { button: 0 })).toBe(false)
  expect(document.activeElement).toBe(editor.view.dom)
  if (action === 'More blocks') {
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(view.getByRole('menuitem', { name: 'Heading 4' }))
  } else {
    fireEvent.click(button)
  }

  if (action === 'Bold') {
    expect(editor.view.dom.querySelector('strong')?.textContent).toBe('caret')
  } else if (action === 'Heading 2' || action === 'More blocks') {
    expect(editor.view.dom.querySelector(action === 'Heading 2' ? 'h2' : 'h4')?.textContent).toBe(
      'lower caret'
    )
    expect(editor.view.dom.querySelector('p')?.textContent).toBe('untouched')
  } else if (action === 'Link') {
    fireEvent.change(view.getByPlaceholderText('Paste or type a link…'), {
      target: { value: 'https://new.test' }
    })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter' })
    expect(editor.view.dom.querySelector('a')?.textContent).toBe('caret')
  } else if (action === 'Remove link') {
    expect(editor.view.dom.querySelectorAll('a')).toHaveLength(1)
    expect(editor.view.dom.querySelector('a')?.textContent).toBe('untouched')
  } else {
    expect(pickImage).toHaveBeenCalledOnce()
    expect(editor.state.selection.anchor).toBe(to)
    expect(editor.state.selection.head).toBe(from)
  }
})

it('publishes a held native range on outside release and exposes its review-note target without another input', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { setMarkdownEditorFocused: vi.fn(), onRichMarkdownContextCommand: () => () => {} }
    }
  })
  const view = render(
    <RichMarkdownEditor
      fileId="release-file"
      viewStateId="release-view"
      content={'untouched\n\n[lower caret](https://selected.test)'}
      filePath="/repo/release.md"
      worktreeId="release-workspace"
      scrollCacheKey="release-file"
      markdownAnnotationsEnabled
      markdownAnnotationFilePath="release.md"
      onContentChange={() => {}}
      onDirtyStateHint={() => {}}
      onSave={() => {}}
    />,
    { wrapper: TooltipProvider }
  )
  await act(async () => {})
  const editor = live.editor
  const paragraph = view.container.querySelector('.rich-markdown-editor p:last-child')
  const text = paragraph?.querySelector('a')?.firstChild ?? paragraph?.firstChild
  if (!editor || !paragraph || !text) {
    throw new Error('Expected mounted editor text')
  }
  vi.useFakeTimers()
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 100, 20))
  act(() => {
    editor.view.focus()
  })
  const from = editor.view.posAtDOM(text, 6)
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: from, inside: -1 })
  fireEvent.mouseDown(paragraph, { button: 0, buttons: 1, shiftKey: true })
  act(() => {
    document.getSelection()?.setBaseAndExtent(text, 11, text, 6)
    document.dispatchEvent(new Event('selectionchange'))
    vi.runAllTimers()
  })
  expect(editor.state.selection.empty).toBe(true)
  expect(view.queryByRole('button', { name: 'Add review note' })).toBeNull()
  act(() => {
    fireEvent.mouseUp(document, { button: 0 })
    vi.runAllTimers()
  })
  expect(editor.state.selection.anchor).toBe(from + 5)
  expect(editor.state.selection.head).toBe(from)
  expect(document.getSelection()?.toString()).toBe('caret')
  expect(view.getByRole('button', { name: 'Remove link' })).toBeTruthy()
  const add = view.getByRole('button', { name: 'Add review note' })
  fireEvent.mouseDown(add, { button: 0 })
  fireEvent.click(add)
  expect(view.getByText('Selected text', { exact: true })).toBeTruthy()
  expect(
    view.container.querySelector('.rich-markdown-annotation-selection-active')?.textContent
  ).toBe('caret')
})
