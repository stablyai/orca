// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Editor, isMacOS, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { CellSelection } from '@tiptap/pm/tables'
import { createIsolatedMarkdownExtensionForTests } from '../schema/isolated-markdown-extension-for-tests'
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

const extensions = [StarterKit, createIsolatedMarkdownExtensionForTests()]

function createEditor(content: JSONContent): Editor {
  return new Editor({
    element: null,
    extensions,
    content
  })
}

const TABLE_MARKDOWN = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

// The StarterKit schema above has no table nodes, so table key paths need this one.
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

function firstEmptyParagraphPosition(editor: Editor): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      position = pos + 1
      return false
    }

    return true
  })

  if (position === null) {
    throw new Error('Expected an empty paragraph in the test document')
  }

  return position
}

function keyEvent(
  key: string,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides
  } as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
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
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

function emptyTopLevelOrderedList(): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { start: 1, type: null },
        content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }]
      }
    ]
  }
}

describe('rich markdown key handler', () => {
  it('preserves a typed empty ordered-list shortcut on Enter', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      editor.commands.setTextSelection(3)
      const ctx = createContext(editor, true)
      const event = keyEvent('Enter')

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(ctx.typedEmptyOrderedListMarkerRef.current).toBe(false)
      expect(editor.getMarkdown()).toBe('1.\n\n')
    } finally {
      editor.destroy()
    }
  })

  it('exits loaded trailing empty ordered-list items on Enter', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }]
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }]
            },
            { type: 'listItem', content: [{ type: 'paragraph' }] }
          ]
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Next section' }] }
      ]
    })

    try {
      editor.commands.setTextSelection(firstEmptyParagraphPosition(editor))
      const event = keyEvent('Enter')

      expect(createRichMarkdownKeyHandler(createContext(editor, false))(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(editor.state.selection.$from.depth).toBe(1)
      expect(editor.state.doc.toJSON()).toMatchObject({
        content: [
          {
            type: 'orderedList',
            content: [{ type: 'listItem' }, { type: 'listItem' }]
          },
          { type: 'paragraph' },
          { type: 'heading' }
        ]
      })
    } finally {
      editor.destroy()
    }
  })

  it('keeps Shift+Enter navigation for a multi-cell selection that cannot take a break', () => {
    const editor = createTableEditor()
    try {
      const cellAt = (text: string) => {
        const $text = editor.state.doc.resolve(caretAtText(editor, text))
        return $text.before($text.depth - 1)
      }
      const first = cellAt('a1')
      const last = cellAt('b1')
      editor.view.dispatch(
        editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last))
      )
      const event = keyEvent('Enter', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor, false))(null, event)).toBe(true)
      expect(editor.state.selection.$from.parent.textContent).toBe('b2')
    } finally {
      editor.destroy()
    }
  })

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
