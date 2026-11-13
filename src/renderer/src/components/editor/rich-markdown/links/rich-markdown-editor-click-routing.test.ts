// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/browser/navigation/http-link-routing'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import { handleRichMarkdownEditorAuxClick } from './rich-markdown-link-dom-events'

const editors: Editor[] = []
const openWorkspaceBrowserMock = vi.fn(async () => 'page-1')
const openUrlMock = vi.fn()

beforeEach(() => {
  openWorkspaceBrowserMock.mockClear()
  openUrlMock.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    shell: {
      openUrl: openUrlMock,
      openFileUri: vi.fn(),
      pathExists: vi.fn(async () => true)
    }
  }
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: false, activeRuntimeEnvironmentId: null },
    setActiveWorktree: vi.fn(),
    createBrowserTab: vi.fn()
  }))
  registerWorkspaceHttpLinkBrowserOpener(openWorkspaceBrowserMock)
})

afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
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

describe('rich markdown URL click and middle-click routing', () => {
  function createUrlEditor(): { editor: Editor; anchor: HTMLAnchorElement } {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: document.body.appendChild(document.createElement('div')),
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor('Read [Orca](https://orca.dev/docs)', codec),
      contentType: 'markdown'
    })
    editors.push(editor)
    const anchor = editor.view.dom.querySelector('a')
    if (!anchor) {
      throw new Error('Expected rendered anchor')
    }
    return { editor, anchor }
  }

  it('opens external URLs in Orca on plain click without modifier keys', () => {
    const { editor, anchor } = createUrlEditor()
    const event = new MouseEvent('click', { button: 0 })
    Object.defineProperty(event, 'target', { value: anchor })

    const handled = handleRichMarkdownEditorClick({
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
      onOpenDocLinkRef: { current: undefined },
      pos: 6,
      rootRef: { current: null },
      scrollRichMarkdownReviewNoteCardIntoView: () => undefined,
      view: editor.view,
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo'
    })

    expect(handled).toBe(true)
    expect(openWorkspaceBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'worktree-1',
        url: 'https://orca.dev/docs'
      })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens external URLs in the system browser on middle-click', () => {
    const { editor, anchor } = createUrlEditor()
    const event = new MouseEvent('auxclick', { button: 1, cancelable: true })
    Object.defineProperty(event, 'target', { value: anchor })

    const handled = handleRichMarkdownEditorAuxClick({
      event,
      filePath: '/repo/docs/index.md',
      htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '/repo/docs/index.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'local' }
      }),
      view: editor.view,
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo'
    })

    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith('https://orca.dev/docs')
    expect(openWorkspaceBrowserMock).not.toHaveBeenCalled()
  })
})
