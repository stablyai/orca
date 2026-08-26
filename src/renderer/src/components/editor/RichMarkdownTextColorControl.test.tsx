// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { Editor } from '@tiptap/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { RichMarkdownTextColorControl } from './RichMarkdownTextColorControl'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
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

describe('RichMarkdownTextColorControl', () => {
  it('applies and clears a selected text color', async () => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec }),
      content: 'colored text',
      contentType: 'markdown'
    })
    editor.commands.setTextSelection({ from: 1, to: 8 })

    try {
      render(<RichMarkdownTextColorControl editor={editor} />)
      fireEvent.click(screen.getByRole('button', { name: 'Red' }))

      await waitFor(() => {
        expect(editor.getMarkdown().trimEnd()).toBe(
          '<span data-orca-text-color="red">colored</span> text'
        )
      })
      expect(screen.getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')).toBe('true')

      fireEvent.click(screen.getByRole('button', { name: 'Clear text color' }))
      await waitFor(() => expect(editor.getMarkdown().trimEnd()).toBe('colored text'))
    } finally {
      editor.destroy()
    }
  })

  it('clears a mixed-color selection without showing a false active color', async () => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec }),
      content:
        '<span data-orca-text-color="red">red</span> <span data-orca-text-color="blue">blue</span>',
      contentType: 'markdown'
    })
    editor.commands.setTextSelection({ from: 1, to: 9 })

    try {
      render(<RichMarkdownTextColorControl editor={editor} />)
      expect(
        screen
          .getByRole('button', { name: 'Text color' })
          .getAttribute('data-rich-markdown-text-color')
      ).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Clear text color' }))
      await waitFor(() => expect(editor.getMarkdown().trimEnd()).toBe('red blue'))
    } finally {
      editor.destroy()
    }
  })
})
