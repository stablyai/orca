import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownKeyHandler, type KeyHandlerContext } from './rich-markdown-key-handler'

function createEditor(content: object): Editor {
  // Why: each Editor needs its own marked registry; sharing one module-scoped
  // extension accumulates tokenizer state across tests.
  return new Editor({
    element: null,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      createIsolatedMarkdownExtensionForTests()
    ],
    content
  })
}

/**
 * Why: mixed bullet/task nesting and code-block indentation only reproduce
 * against the live extension set, not the trimmed StarterKit one above.
 */
function createMarkdownEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({
      codec: createRichMarkdownEditorCodec()
    }),
    content: markdown,
    contentType: 'markdown'
  })
}

/**
 * Why: pasted list HTML is the path the reported bug came in through — the
 * editor has no plain-text markdown paste transform. The DOM-less test env
 * cannot parse HTML, so assert against the node shapes that paste produces.
 */
function createNodeEditor(content: object): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({
      codec: createRichMarkdownEditorCodec()
    }),
    content
  })
}

function para(text: string): object {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function bullets(...items: object[][]): object {
  return {
    type: 'bulletList',
    content: items.map((content) => ({ type: 'listItem', content }))
  }
}

function tasks(...items: object[][]): object {
  return {
    type: 'taskList',
    content: items.map((content) => ({
      type: 'taskItem',
      attrs: { checked: false },
      content
    }))
  }
}

function doc(...content: object[]): object {
  return { type: 'doc', content }
}

function textPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(text)) {
      position = pos + 1
      return false
    }

    return true
  })

  if (position === null) {
    throw new Error(`Expected text in test document: ${text}`)
  }

  return position
}

function codeBlockPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock' && node.textContent.includes(text)) {
      position = pos + 1 + node.textContent.indexOf(text)
      return false
    }

    return true
  })

  if (position === null) {
    throw new Error(`Expected code block text: ${text}`)
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

function createContext(editor: Editor): KeyHandlerContext {
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
    typedEmptyOrderedListMarkerRef: { current: false },
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
    openAnnotationPopoverRef: { current: vi.fn() },
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

function bulletListDocument(): object {
  return {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }]
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }]
          }
        ]
      }
    ]
  }
}

function parentAndFixesDocument(): object {
  return {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Parent' }]
              }
            ]
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'FixA' }] }]
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'FixB' }] }]
          }
        ]
      }
    ]
  }
}

function taskListDocument(): object {
  return {
    type: 'doc',
    content: [
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Task A' }]
              }
            ]
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Task B' }]
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('rich markdown Tab key handler', () => {
  it('flushes pending ProseMirror DOM selection before indenting lists', () => {
    const calls: string[] = []
    const editor = {
      view: {
        composing: false,
        domObserver: {
          currentSelection: {
            set: vi.fn(() => calls.push('reset-selection'))
          },
          flush: vi.fn(() => calls.push('flush'))
        }
      },
      state: { selection: { $from: { depth: 0 } } },
      commands: {
        sinkListItem: vi.fn((type) => {
          calls.push(`sink:${String(type)}`)
          return true
        }),
        liftListItem: vi.fn(),
        insertContent: vi.fn()
      },
      isActive: vi.fn(() => false)
    } as unknown as Editor
    const event = keyEvent('Tab')

    expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
    expect(calls).toEqual(['reset-selection', 'flush', 'sink:listItem'])
  })

  it('indents FixA under a preceding parent item on Tab', () => {
    const editor = createEditor(parentAndFixesDocument())

    try {
      editor.commands.setTextSelection(textPosition(editor, 'FixA'))
      const event = keyEvent('Tab')

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- Parent\n  - FixA\n- FixB')
    } finally {
      editor.destroy()
    }
  })

  it('indents second bullet list item on Tab', () => {
    const editor = createEditor(bulletListDocument())

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Beta'))
      const event = keyEvent('Tab')

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- Alpha\n  - Beta')
    } finally {
      editor.destroy()
    }
  })

  it('keeps first list item Tab consumed without changing the document', () => {
    const editor = createEditor(bulletListDocument())

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Alpha'))
      const event = keyEvent('Tab')

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(editor.getMarkdown()).toBe('- Alpha\n- Beta')
    } finally {
      editor.destroy()
    }
  })

  it('indents second task item through the taskItem fallback', () => {
    const editor = createEditor(taskListDocument())

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Task B'))
      const event = keyEvent('Tab')

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- [ ] Task A\n  - [ ] Task B')
    } finally {
      editor.destroy()
    }
  })

  it('outdents a bullet nested inside a task item into the enclosing task list', () => {
    const editor = createMarkdownEditor('- [ ] Task A\n  - Bullet B')

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Bullet B'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- [ ] Task A\n- [ ] Bullet B')
    } finally {
      editor.destroy()
    }
  })

  it('outdents a task nested inside a bullet item into the enclosing bullet list', () => {
    const editor = createMarkdownEditor('- Bullet A\n  - [ ] Task B')

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Task B'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- Bullet A\n- Task B')
    } finally {
      editor.destroy()
    }
  })

  it('keeps sibling bullets that stay behind when outdenting out of a task item', () => {
    const editor = createMarkdownEditor('- [ ] Task A\n  - Bullet X\n  - Bullet Y')

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Bullet Y'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- [ ] Task A\n  - Bullet X\n- [ ] Bullet Y')
    } finally {
      editor.destroy()
    }
  })

  it('outdents one level into the enclosing task list in a mixed nest', () => {
    const editor = createMarkdownEditor('- A\n  - [ ] B\n    - C')

    try {
      editor.commands.setTextSelection(textPosition(editor, 'C'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- A\n  - [ ] B\n  - [ ] C')
    } finally {
      editor.destroy()
    }
  })

  it('outdents a nested bullet list item on Shift-Tab', () => {
    const editor = createMarkdownEditor('- Alpha\n  - Beta')

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Beta'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- Alpha\n- Beta')
    } finally {
      editor.destroy()
    }
  })

  it('removes one indent step from a code block line on Shift-Tab', () => {
    const editor = createMarkdownEditor('```js\n    const x = 1\n```')

    try {
      editor.commands.setTextSelection(codeBlockPosition(editor, 'const x'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('```js\n  const x = 1\n```')
    } finally {
      editor.destroy()
    }
  })

  it('outdents every code block line the selection touches', () => {
    const editor = createMarkdownEditor('```js\n  a\n  b\n  c\n```')

    try {
      editor.commands.setTextSelection({
        from: codeBlockPosition(editor, 'a'),
        to: codeBlockPosition(editor, 'b') + 1
      })
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('```js\na\nb\n  c\n```')
    } finally {
      editor.destroy()
    }
  })

  it('leaves an unindented code block untouched on Shift-Tab', () => {
    const editor = createMarkdownEditor('```js\nconst x = 1\n```')

    try {
      editor.commands.setTextSelection(codeBlockPosition(editor, 'const x'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('```js\nconst x = 1\n```')
    } finally {
      editor.destroy()
    }
  })

  it('inserts spaces for Tab in code blocks', () => {
    const insertContent = vi.fn()
    const editor = {
      view: { composing: false },
      state: { selection: { $from: { depth: 0 } } },
      commands: {
        sinkListItem: vi.fn(),
        liftListItem: vi.fn(),
        insertContent
      },
      isActive: vi.fn((name) => name === 'codeBlock')
    } as unknown as Editor
    const event = keyEvent('Tab')

    expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
    expect(insertContent).toHaveBeenCalledWith('  ')
  })

  it('outdents a nested bullet that arrived as a pasted list node tree', () => {
    const editor = createNodeEditor(doc(bullets([para('One'), bullets([para('Two')])])))

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Two'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- One\n- Two')
    } finally {
      editor.destroy()
    }
  })

  it('outdents a bullet nested under a pasted task item', () => {
    const editor = createNodeEditor(doc(tasks([para('Task A'), bullets([para('Bullet B')])])))

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Bullet B'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- [ ] Task A\n- [ ] Bullet B')
    } finally {
      editor.destroy()
    }
  })

  it('keeps pasted sibling bullets behind when outdenting out of a task item', () => {
    const editor = createNodeEditor(
      doc(tasks([para('Task A'), bullets([para('Bullet X')], [para('Bullet Y')])]))
    )

    try {
      editor.commands.setTextSelection(textPosition(editor, 'Bullet Y'))
      const event = keyEvent('Tab', { shiftKey: true })

      expect(createRichMarkdownKeyHandler(createContext(editor))(null, event)).toBe(true)
      expect(editor.getMarkdown()).toBe('- [ ] Task A\n  - Bullet X\n- [ ] Bullet Y')
    } finally {
      editor.destroy()
    }
  })

})
