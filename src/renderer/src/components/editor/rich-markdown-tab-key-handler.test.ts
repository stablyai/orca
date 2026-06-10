import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from '@tiptap/markdown'
import { createRichMarkdownKeyHandler, type KeyHandlerContext } from './rich-markdown-key-handler'

const extensions = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Markdown.configure({ markedOptions: { gfm: true } })
]

function createEditor(content: object): Editor {
  return new Editor({
    element: null,
    extensions,
    content
  })
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
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] }]
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
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task A' }] }]
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task B' }] }]
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

  it('inserts spaces for Tab in code blocks', () => {
    const insertContent = vi.fn()
    const editor = {
      view: { composing: false },
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
})
