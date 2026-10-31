// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { createMarkdownDocLink } from './rich-markdown-doc-link'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []
const guide: MarkdownDocument = {
  filePath: '/repo/Guide.md',
  relativePath: 'Guide.md',
  basename: 'Guide.md',
  name: 'Guide'
}
function docLinkEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, createMarkdownDocLink(createRichMarkdownEditorCodec().transport)],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'markdownDocLink', attrs: { target: 'Guide', label: 'Read guide' } }]
        }
      ]
    }
  })
  editors.push(editor)
  return editor
}
function updateDocuments(editor: Editor, documents: MarkdownDocument[]): void {
  const storage = editor.storage.markdownDocLink
  if (!storage) {
    throw new Error('Missing document-link storage')
  }
  storage.documents = documents
  editor.view.dispatch(editor.state.tr.setMeta('docLinksUpdated', true))
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('rich document link metadata refresh', () => {
  it('resolves an existing link after the document list arrives without editing the document', () => {
    const editor = docLinkEditor()
    const link = editor.view.dom.querySelector('[data-doc-link-target="Guide"]')
    expect(link?.classList.contains('rich-markdown-doc-link--missing')).toBe(true)
    const before = editor.state.doc
    const selection = editor.state.selection
    updateDocuments(editor, [guide])
    expect(link?.classList.contains('rich-markdown-doc-link--missing')).toBe(false)
    expect(editor.state.doc).toBe(before)
    expect(editor.state.selection.eq(selection)).toBe(true)
    expect(link?.textContent).toBe('Read guide')
    expect(editor.view.dom.querySelector('[data-doc-link-target="Guide"]')).toBe(link)
  })

  it('marks an existing resolved link missing after its document is removed', () => {
    const editor = docLinkEditor()
    updateDocuments(editor, [guide])
    // A changed node forces resolution on the baseline too, isolating the removal refresh.
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(1, undefined, { target: 'Guide', label: 'Open guide' })
    )
    const link = editor.view.dom.querySelector('[data-doc-link-target="Guide"]')
    expect(link?.classList.contains('rich-markdown-doc-link--missing')).toBe(false)
    const before = editor.state.doc
    updateDocuments(editor, [])
    expect(link?.classList.contains('rich-markdown-doc-link--missing')).toBe(true)
    expect(editor.state.doc).toBe(before)
    expect(link?.textContent).toBe('Open guide')
  })
})
