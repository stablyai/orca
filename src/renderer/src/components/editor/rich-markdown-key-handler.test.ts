import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { createRichMarkdownKeyHandler, type KeyHandlerContext } from './rich-markdown-key-handler'

const extensions = [StarterKit, Markdown.configure({ markedOptions: { gfm: true } })]

function createEditor(content: object): Editor {
  return new Editor({
    element: null,
    extensions,
    content
  })
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
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

function emptyTopLevelOrderedList(): object {
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

  it('leaves toolbar-created empty ordered lists to the default Enter behavior', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      editor.commands.setTextSelection(3)
      const event = keyEvent('Enter')

      expect(createRichMarkdownKeyHandler(createContext(editor, false))(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(editor.state.doc.toJSON()).toEqual(emptyTopLevelOrderedList())
    } finally {
      editor.destroy()
    }
  })

  it('does not rewrite empty ordered-list input during IME composition', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      editor.commands.setTextSelection(3)
      const event = keyEvent('Enter', { isComposing: true })

      expect(createRichMarkdownKeyHandler(createContext(editor, true))(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(editor.state.doc.toJSON()).toEqual(emptyTopLevelOrderedList())
    } finally {
      editor.destroy()
    }
  })

  it('keeps slash-menu filter input out of the document', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '/' }] }]
    })

    try {
      editor.commands.setTextSelection(2)
      let slashMenu = { query: '', from: 1, to: 2, left: 0, top: 0 }
      const ctx = createContext(editor, false)
      ctx.slashMenuRef.current = slashMenu
      ctx.filteredSlashCommandsRef.current = [{ id: 'heading-1' } as never]
      ctx.setSlashMenu = vi.fn((next) => {
        slashMenu = typeof next === 'function' ? next(slashMenu) : next
        ctx.slashMenuRef.current = slashMenu
      })
      const event = keyEvent('h')

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(editor.getText()).toBe('/')
      expect(ctx.slashMenuRef.current?.query).toBe('h')
    } finally {
      editor.destroy()
    }
  })
})
