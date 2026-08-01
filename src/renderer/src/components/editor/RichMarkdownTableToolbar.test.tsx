// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { RichMarkdownTableToolbar } from './RichMarkdownTableToolbar'

function createEditor(content: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('RichMarkdownTableToolbar', () => {
  it('stays hidden outside tables', () => {
    editor = createEditor('Paragraph')
    const { container } = render(<RichMarkdownTableToolbar editor={editor} />)

    expect(container.innerHTML).toBe('')
  })

  it('shows all table actions while a table cell is active', () => {
    editor = createEditor(`| A | B |
| --- | --- |
| a1 | b1 |
`)
    render(<RichMarkdownTableToolbar editor={editor} />)

    expect(screen.getByRole('button', { name: 'Insert row above' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Insert row below' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete current row' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Insert column left' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Insert column right' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete current column' })).toBeTruthy()
  })
})
