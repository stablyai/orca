// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'

const editors: Editor[] = []
const source = 'https://uploads.linear.app/workspace/image'

function createEditor() {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    extensions: createRichMarkdownExtensions({ codec }),
    content: `Before\n\n![Screenshot](${source})\n\nAfter`,
    contentType: 'markdown'
  })
  document.body.append(editor.view.dom)
  editors.push(editor)
  return editor
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('signed images in rich Markdown', () => {
  it('displays signed URLs while edits and serialization retain the source URL', () => {
    const editor = createEditor()
    const signed = `${source}?signature=temporary`
    setRichMarkdownImageResolverContext(editor, { filePath: '', imageUrls: { [source]: signed } })
    expect(editor.view.dom.querySelector('img')?.src).toBe(signed)
    editor.commands.insertContentAt(1, 'Edited ')
    expect(editor.getMarkdown()).toContain(`![Screenshot](${source})`)
    expect(editor.getMarkdown()).toContain('Edited Before')
    expect(editor.getMarkdown()).not.toContain('signature')
    expect(editor.getHTML()).not.toContain('signature')
  })

  it('refreshes signatures without replacing the document or disturbing selection', () => {
    const editor = createEditor()
    editor.commands.setTextSelection(3)
    const doc = editor.state.doc
    for (const signature of ['first', 'refreshed']) {
      const signed = `${source}?signature=${signature}`
      setRichMarkdownImageResolverContext(editor, { filePath: '', imageUrls: { [source]: signed } })
      expect(editor.view.dom.querySelector('img')?.src).toBe(signed)
      expect(editor.state.doc).toBe(doc)
      expect(editor.state.selection.from).toBe(3)
    }
  })

  it('clears the previous issue mapping and leaves ordinary URLs alone', () => {
    const editor = createEditor()
    setRichMarkdownImageResolverContext(editor, {
      filePath: '',
      imageUrls: { [source]: `${source}?signature=temporary` }
    })
    setRichMarkdownImageResolverContext(editor, { filePath: '' })
    expect(editor.view.dom.querySelector('img')?.src).toBe(source)
  })
})
