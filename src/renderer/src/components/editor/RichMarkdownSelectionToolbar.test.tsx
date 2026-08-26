// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { Editor } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  RichMarkdownSelectionToolbar,
  shouldShowRichMarkdownSelectionToolbar
} from './RichMarkdownSelectionToolbar'

const menuState = vi.hoisted(() => ({
  onHide: null as (() => void) | null,
  popoverOpen: undefined as boolean | undefined,
  onPopoverOpenChange: null as ((open: boolean) => void) | null
}))

vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: ({
    children,
    options
  }: {
    children: ReactNode
    options?: { onHide?: () => void }
  }) => {
    menuState.onHide = options?.onHide ?? null
    return <div>{children}</div>
  }
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    menuState.popoverOpen = open
    menuState.onPopoverOpenChange = onOpenChange ?? null
    return <>{children}</>
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

afterEach(cleanup)

function createEditor(content = 'selected text'): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

describe('RichMarkdownSelectionToolbar', () => {
  it('shows only for a focused, non-empty text selection', () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 9 })
    const element = document.createElement('div')
    const view = { hasFocus: () => true } as EditorView

    try {
      expect(
        shouldShowRichMarkdownSelectionToolbar({
          blocked: false,
          editor,
          element,
          view,
          state: editor.state,
          from: 1,
          to: 9
        })
      ).toBe(true)

      expect(
        shouldShowRichMarkdownSelectionToolbar({
          blocked: true,
          editor,
          element,
          view,
          state: editor.state,
          from: 1,
          to: 9
        })
      ).toBe(false)

      editor.commands.setTextSelection(1)
      expect(
        shouldShowRichMarkdownSelectionToolbar({
          blocked: false,
          editor,
          element,
          view,
          state: editor.state,
          from: 1,
          to: 1
        })
      ).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('exposes inline formatting and text color actions', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 9 })

    try {
      render(
        <RichMarkdownSelectionToolbar
          editor={editor}
          blocked={false}
          scrollContainer={null}
          onToggleLink={vi.fn()}
        />
      )

      expect(screen.getByRole('button', { name: 'Text color' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Bold' }))

      await waitFor(() => expect(editor.getMarkdown().trimEnd()).toBe('**selected** text'))
      expect(screen.getByRole('button', { name: 'Bold' }).classList.contains('is-active')).toBe(
        true
      )
    } finally {
      editor.destroy()
    }
  })

  it('closes the text color popover when the selection collapses', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 9 })

    try {
      render(
        <RichMarkdownSelectionToolbar
          editor={editor}
          blocked={false}
          scrollContainer={null}
          onToggleLink={vi.fn()}
        />
      )

      act(() => menuState.onPopoverOpenChange?.(true))
      expect(menuState.popoverOpen).toBe(true)

      act(() => editor.commands.setTextSelection(1))
      await waitFor(() => expect(menuState.popoverOpen).toBe(false))
    } finally {
      editor.destroy()
    }
  })
})
