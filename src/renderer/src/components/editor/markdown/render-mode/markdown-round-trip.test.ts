import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from '../../rich-markdown/raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../../rich-markdown/schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../../rich-markdown/document/rich-markdown-source-transport'

function roundTripMarkdown(content: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    // Serialization can match byte-for-byte while schema-invalid content crashes on the next edit; check the document too.
    editor.state.doc.check()
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function markdownAfterTextReplace(content: string, search: string, replacement: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    let from = -1
    editor.state.doc.descendants((node, pos) => {
      if (from !== -1 || !node.isText || !node.text) {
        return
      }
      const index = node.text.indexOf(search)
      if (index !== -1) {
        from = pos + index
      }
    })
    if (from === -1) {
      throw new Error(`Missing text: ${search}`)
    }
    editor.view.dispatch(editor.state.tr.insertText(replacement, from, from + search.length))
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function markdownAfterTypingBesideImage(content: string, typed: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    let after = -1
    editor.state.doc.descendants((node, pos) => {
      if (after === -1 && node.type.name === 'image') {
        after = pos + node.nodeSize
      }
    })
    if (after === -1) {
      throw new Error('Missing image node')
    }
    editor.view.dispatch(editor.state.tr.insertText(typed, after, after))
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

describe('rich markdown round trip', () => {
  it('preserves an image in a details summary across an edit', () => {
    expect(
      markdownAfterTextReplace(
        '<details><summary>Toggle ![i](x.png)</summary><p>Body</p></details>\n',
        'Toggle',
        'Switch'
      )
    ).toBe(
      '<details class="orca-details">\n<summary>Switch ![i](x.png)</summary>\n\nBody\n\n</details>'
    )
  })

  it('keeps nested toggle bodies editable rather than inert raw html', () => {
    const markdown = markdownAfterTextReplace(
      [
        '<details class="orca-details" open>',
        '<summary>Outer</summary>',
        '',
        '<details class="orca-details" open>',
        '<summary>Inner</summary>',
        '',
        'Body',
        '',
        '</details>',
        '',
        '</details>',
        ''
      ].join('\n'),
      'Body',
      'Edited body'
    )
    expect(markdown).toContain('Edited body')
  })

  it('preserves a standalone image as its own block', () => {
    expect(roundTripMarkdown('Intro\n\n![shot](shot.png)\n\nOutro\n')).toBe(
      'Intro\n\n![shot](shot.png)\n\nOutro'
    )
    // Standalone images must stay in paragraphs so adjacent typing joins the same block.
    expect(markdownAfterTypingBesideImage('Intro\n\n![shot](shot.png)\n\nOutro\n', 'X')).toBe(
      'Intro\n\n![shot](shot.png)X\n\nOutro'
    )
  })
})
