// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { createMarkdownDocLink } from '../doc-links/rich-markdown-doc-link'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'

const editors: Editor[] = []

function docLinkEditor(): Editor {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, createMarkdownDocLink(createRichMarkdownEditorCodec().transport)],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'markdownDocLink',
              attrs: { target: 'docs/guide', label: 'some label' }
            },
            { type: 'text', text: ' next' }
          ]
        }
      ]
    }
  })
  editors.push(editor)
  return editor
}

function linkPosition(editor: Editor): { pos: number; after: number } {
  let pos = -1
  editor.state.doc.descendants((node, nodePos) => {
    if (node.type.name === 'markdownDocLink') {
      pos = nodePos
    }
  })
  return { pos, after: pos + 1 }
}

function clickDocLink(
  editor: Editor,
  pos: number,
  target: EventTarget
): { handled: boolean; opened: string[] } {
  const opened: string[] = []
  const handled = handleRichMarkdownEditorClick({
    activateMarkdownLink: () => undefined,
    editorRef: { current: editor },
    event: {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      target,
      preventDefault() {}
    } as MouseEvent,
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
    onOpenDocLinkRef: {
      current: (docTarget) => {
        opened.push(docTarget)
      }
    },
    pos,
    rootRef: { current: null },
    scrollRichMarkdownReviewNoteCardIntoView: () => undefined,
    view: editor.view,
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo'
  })
  return { handled, opened }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.view.dom.remove()
    editor.destroy()
  })
})

describe('rich markdown document link clicks', () => {
  it('opens a wikilink from the right half of its rendered label', () => {
    const editor = docLinkEditor()
    const { pos, after } = linkPosition(editor)
    const span = editor.view.dom.querySelector('[data-doc-link-target="docs/guide"]')
    const label = span?.firstChild
    expect(span).toBeInstanceOf(HTMLElement)
    expect(label).toBeInstanceOf(Text)
    expect(editor.state.doc.nodeAt(pos)?.type.name).toBe('markdownDocLink')
    expect(editor.state.doc.nodeAt(after)?.type.name).not.toBe('markdownDocLink')

    expect(clickDocLink(editor, pos, span as HTMLElement)).toEqual({
      handled: true,
      opened: ['docs/guide']
    })
    expect(clickDocLink(editor, after, label as Text)).toEqual({
      handled: true,
      opened: ['docs/guide']
    })
  })

  it('does not open a wikilink when the modifier click lands on the following text', () => {
    const editor = docLinkEditor()
    const { after } = linkPosition(editor)
    const following = Array.from(editor.view.dom.querySelector('p')?.childNodes ?? []).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('next')
    )
    expect(following).toBeInstanceOf(Text)

    expect(clickDocLink(editor, after, following as Text)).toEqual({
      handled: false,
      opened: []
    })
  })
})
