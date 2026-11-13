// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

function createDocLinkEditor(): Editor {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor('See [[docs/guide|some label]] next', codec),
    contentType: 'markdown'
  })
  editors.push(editor)
  return editor
}

function docLinkEnd(editor: Editor): number {
  let end = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'markdownDocLink') {
      end = pos + node.nodeSize
    }
  })
  return end
}

// posAtCoords puts a click on the right half of an inline atom at the position after it.
function modClickAt(editor: Editor, pos: number, target: Element): string[] {
  const opened: string[] = []
  const event = new MouseEvent('click', { metaKey: true })
  Object.defineProperty(event, 'target', { value: target })
  handleRichMarkdownEditorClick({
    activateMarkdownLink: () => undefined,
    editorRef: { current: editor },
    event,
    filePath: '/repo/docs/index.md',
    isMac: true,
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/docs/index.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    }),
    markdownCommentsRef: { current: [] },
    markdownSourceLineOffsetRef: { current: 0 },
    onOpenDocLinkRef: { current: (docTarget) => opened.push(docTarget) },
    pos,
    rootRef: { current: null },
    scrollRichMarkdownReviewNoteCardIntoView: () => undefined,
    view: editor.view,
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo'
  })
  return opened
}

describe('rich markdown modifier-click on a wikilink', () => {
  it('opens the wikilink from the right half of its label', () => {
    const editor = createDocLinkEditor()
    const label = editor.view.dom.querySelector('[data-doc-link-target]')
    expect(label).not.toBeNull()

    expect(modClickAt(editor, docLinkEnd(editor), label!)).toEqual(['docs/guide'])
  })
})
