import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

// Crash report 0e46c048: Vietnamese prose with a soft line break, an inline code
// span and an inline image, which the markdown parser nests inside one paragraph.
const CRASH_SOURCE =
  'Trình duyệt chỉ cho phép cài từ Web Store.\nnh `.crx` (tham chiếu, KHÔNG chặn) ![ảnh](chrome.png) và tiếp tục\n'

function createRichMarkdownEditorFromSource(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '',
        worktreeId: '',
        worktreeRoot: null,
        sourceOwner: { kind: 'unknown' }
      })
    }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec, { htmlSuperscriptLinks: true }),
    contentType: 'markdown'
  })
}

describe('rich markdown inline images inside a paragraph', () => {
  it('parses an inline image into a schema-valid paragraph', () => {
    const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

    try {
      expect(() => editor.state.doc.check()).not.toThrow()
    } finally {
      editor.destroy()
    }
  })

  it('survives an ordinary edit in a paragraph that holds an inline image', () => {
    const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

    try {
      // Any ReplaceStep that rebuilds the paragraph runs NodeType.checkContent on
      // the reassembled content — the exact frame the crash report bottoms out in.
      expect(() => editor.view.dispatch(editor.state.tr.insertText('X', 5, 8))).not.toThrow()
    } finally {
      editor.destroy()
    }
  })

  it('round-trips the reported document without dropping the inline image', () => {
    const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

    try {
      // Why: serialization never runs NodeType.checkContent, so the markdown
      // matches byte-for-byte even when the document is schema-invalid.
      expect(() => editor.state.doc.check()).not.toThrow()
      expect(editor.getMarkdown().trimEnd()).toBe(CRASH_SOURCE.trimEnd())
    } finally {
      editor.destroy()
    }
  })

  it('keeps a standalone image inside a paragraph rather than directly under the doc', () => {
    // Upstream's paragraph parser hoists a lone image out of its paragraph, which
    // leaves an inline node as a direct child of `doc` once images are inline.
    const editor = createRichMarkdownEditorFromSource('Intro\n\n![shot](shot.png)\n\nOutro\n')

    try {
      expect(() => editor.state.doc.check()).not.toThrow()
      expect(editor.state.doc.child(1).type.name).toBe('paragraph')
    } finally {
      editor.destroy()
    }
  })

  it('keeps a markdown inline image as an inline node', () => {
    const editor = createRichMarkdownEditorFromSource(CRASH_SOURCE)

    try {
      const paragraph = editor.state.doc.child(0)
      const imageIndex = [...Array(paragraph.childCount).keys()].find(
        (index) => paragraph.child(index).type.name === 'image'
      )
      expect(imageIndex).toBeDefined()
      expect(paragraph.child(imageIndex!).type.isInline).toBe(true)
    } finally {
      editor.destroy()
    }
  })
})
