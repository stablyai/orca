// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type * as EditorInstance from './useRichMarkdownEditorInstance'
import RichMarkdownEditor from './RichMarkdownEditor'

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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  live.editor = null
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
    await act(async () => {})
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
