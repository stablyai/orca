import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import { createRichMarkdownKeyHandler, type KeyHandlerContext } from './rich-markdown-key-handler'

// Why: keybinding matching resolves the platform from navigator.userAgent,
// which is environment-dependent under vitest; pin it for determinism.
vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => 'darwin' as NodeJS.Platform
}))

const extensions = [StarterKit, createIsolatedMarkdownExtensionForTests()]

function createEditor(content: object): Editor {
  return new Editor({
    element: null,
    extensions,
    content
  })
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
  it('opens the review-note composer on the add-review-note shortcut', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      const ctx = createContext(editor, false)
      const event = keyEvent('a', { metaKey: true, shiftKey: true, code: 'KeyA' })

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(ctx.openAnnotationPopoverRef.current).toHaveBeenCalledWith(true)
    } finally {
      editor.destroy()
    }
  })

  it('leaves the add-review-note chord unconsumed when no composer opens', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      const ctx = createContext(editor, false)
      ctx.openAnnotationPopoverRef.current = vi.fn(() => false)
      const event = keyEvent('a', { metaKey: true, shiftKey: true, code: 'KeyA' })

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(ctx.openAnnotationPopoverRef.current).toHaveBeenCalledTimes(1)
    } finally {
      editor.destroy()
    }
  })

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

  it('lets slash-menu filter input fall through to document input', () => {
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

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(editor.getText()).toBe('/')
      expect(ctx.slashMenuRef.current?.query).toBe('')
    } finally {
      editor.destroy()
    }
  })

  it('dismisses the slash menu on Escape even when search has no matches', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '/zzz' }] }]
    })

    try {
      editor.commands.setTextSelection(5)
      const ctx = createContext(editor, false)
      ctx.slashMenuRef.current = { query: 'zzz', from: 1, to: 5, left: 0, top: 0 }
      ctx.filteredSlashCommandsRef.current = []
      ctx.setSlashMenu = vi.fn()
      const event = keyEvent('Escape')

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(ctx.setSlashMenu).toHaveBeenCalledWith(null)
    } finally {
      editor.destroy()
    }
  })
})
