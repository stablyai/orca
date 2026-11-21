// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Editor, isMacOS } from '@tiptap/core'
import { createRichMarkdownKeyHandler } from './rich-markdown-key-handler'
import type { KeyHandlerContext } from './rich-markdown-key-handler-context'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'

// Pin the shortcut platform because navigator.userAgent varies across test environments.
vi.mock('@/lib/keyboard/shortcut-platform', () => ({
  getShortcutPlatform: () => 'darwin' as NodeJS.Platform
}))

const TABLE_MARKDOWN = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

function createTableEditor(): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: TABLE_MARKDOWN,
    contentType: 'markdown'
  })
}

function caretAtText(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || node.text !== text) {
      return true
    }
    position = pos
    return false
  })

  if (position === null) {
    throw new Error(`Expected cell text: ${text}`)
  }

  return position
}

function createContext(editor: Editor, typedMarker: boolean): KeyHandlerContext {
  return {
    isMac: true,
    editorRef: { current: editor },
    rootRef: { current: null },
    lastCommittedMarkdownRef: { current: '' },
    originalSourceRef: { current: '' },
    baseCanonicalRef: { current: '' },
    reconcileRoundTripRef: { current: () => null },
    onContentChangeRef: { current: vi.fn() },
    onSaveRef: { current: vi.fn() },
    isEditingLinkRef: { current: false },
    slashMenuRef: { current: null },
    filteredSlashCommandsRef: { current: [] },
    selectedCommandIndexRef: { current: 0 },
    docLinkMenuRef: { current: null },
    filteredDocLinkRowsRef: { current: [] },
    selectedDocLinkIndexRef: { current: 0 },
    handleLocalImagePickRef: { current: vi.fn() },
    handleEmojiPickRef: { current: vi.fn() },
    typedEmptyOrderedListMarkerRef: { current: typedMarker },
    flushPendingSerialization: vi.fn(),
    openSearchRef: { current: vi.fn() },
    linkBubbleOwnerId: 'test-owner',
    htmlSuperscriptLinkContext: {
      getSnapshot: () => ({
        sourceFilePath: '/repo/README.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'local' as const },
        version: 0
      }),
      subscribe: () => () => {},
      update: () => {}
    },
    openAnnotationPopoverRef: { current: vi.fn(() => true) },
    addSelectionToLastAgentRef: { current: () => false },
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

describe('rich markdown key handler', () => {
  it.each(['Shift-Enter', 'Mod-Enter'])(
    'preserves the table line break inserted by %s through save and reopen',
    (shortcut) => {
      const editor = createTableEditor()
      const element = document.createElement('div')
      document.body.append(element)
      editor.mount(element)
      try {
        editor.commands.setTextSelection(caretAtText(editor, 'a1') + 1)
        const ctx = createContext(editor, false)
        ctx.isMac = isMacOS()
        editor.setOptions({ editorProps: { handleKeyDown: createRichMarkdownKeyHandler(ctx) } })
        const originalSourceRef = { current: TABLE_MARKDOWN }
        const baseCanonicalRef = { current: editor.getMarkdown() }
        const lastCommittedMarkdownRef = { current: TABLE_MARKDOWN }

        expect(editor.commands.keyboardShortcut(shortcut)).toBe(true)
        expect(editor.state.selection.$from.parent.child(1).type.name).toBe('hardBreak')

        const reopen = (source: string): Editor => {
          const codec = createRichMarkdownEditorCodec()
          return new Editor({
            element: null,
            extensions: createRichMarkdownExtensions({ codec }),
            content: encodeRawMarkdownHtmlForRichEditor(source, codec),
            contentType: 'markdown'
          })
        }
        const saved = commitRichMarkdownSerialization(
          editor,
          { originalSourceRef, baseCanonicalRef, lastCommittedMarkdownRef },
          (source) => {
            const check = reopen(source)
            try {
              return check.getMarkdown()
            } finally {
              check.destroy()
            }
          }
        )
        expect(saved.didSerialize).toBe(true)
        expect(saved.markdown).toContain('a<br>1')
        const reopened = reopen(saved.markdown)
        try {
          reopened.state.doc.check()
          const rendered = document.createElement('div')
          rendered.innerHTML = reopened.getHTML()
          expect(rendered.querySelector('td')?.textContent).toBe('a1')
          expect(rendered.querySelectorAll('td br')).toHaveLength(1)
          expect(reopened.getText()).toContain('b1')
          expect(reopened.getText()).toContain('a2')
        } finally {
          reopened.destroy()
        }
      } finally {
        editor.destroy()
        element.remove()
      }
    }
  )
})
