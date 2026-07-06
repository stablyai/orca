import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { Markdown } from '@tiptap/markdown'
import { normalizeEmptyListItems } from './rich-markdown-normalize'

const testExtensions = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Markdown.configure({ markedOptions: { gfm: true } })
]

function createEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: testExtensions,
    content: markdown,
    contentType: 'markdown'
  })
}

function trimEnd(s: string): string {
  return s.trimEnd()
}

function shouldSyncPropIntoEditor(
  currentMarkdown: string,
  propContent: string,
  lastCommittedMarkdown: string
): boolean {
  if (propContent === lastCommittedMarkdown) {
    return false
  }
  if (currentMarkdown === propContent) {
    return false
  }
  return true
}

/**
 * Simulates the onCreate flow: empty-list repair then getMarkdown().
 */
function simulateOnCreate(diskContent: string): string {
  const editor = createEditor(diskContent)
  try {
    normalizeEmptyListItems(editor)
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

// -----------------------------------------------------------------------
// 1. trimEnd normalization prevents phantom dirty from trailing newlines
//
// getMarkdown() always appends a trailing \n. For content that round-trips
// cleanly (no structural repair changes), the ONLY difference is that
// trailing newline. trimEnd() must eliminate that false positive.
// -----------------------------------------------------------------------
describe('trailing newline does not cause false dirty state', () => {
  const roundTripCases: [string, string][] = [
    ['simple paragraph', 'Hello world'],
    ['paragraph with trailing newline', 'Hello world\n'],
    ['heading and paragraph', '# Title\n\nSome body text'],
    ['multiple paragraphs', 'First paragraph\n\nSecond paragraph\n'],
    ['bold and italic', '**bold** and *italic* text'],
    ['inline code', 'Use `console.log()` here'],
    ['fenced code block', '```js\nconst x = 1\n```\n'],
    ['unordered list', '- item one\n- item two\n- item three'],
    ['ordered list', '1. first\n2. second\n3. third'],
    ['nested list', '- parent\n  - child\n  - child 2'],
    ['link', 'Click [here](https://example.com) please'],
    ['heading hierarchy', '# H1\n\n## H2\n\n### H3\n\nBody'],
    ['task list', '- [x] done\n- [ ] todo'],
    ['horizontal rule', 'Above\n\n---\n\nBelow'],
    ['empty document', '']
  ]

  it.each(roundTripCases)('%s: trimEnd comparison reports clean', (_label, diskContent) => {
    const serialized = simulateOnCreate(diskContent)
    expect(trimEnd(serialized)).toBe(trimEnd(diskContent))
  })
})

// -----------------------------------------------------------------------
// 2. Hard-wrapped prose must stay structurally clean. The rich editor renders
//    soft breaks through CSS reflow, not by splitting the document model.
// -----------------------------------------------------------------------
describe('document soft-break round-trip', () => {
  it('keeps consecutive source lines in one paragraph', () => {
    const editor = createEditor('Line one\nLine two\nLine three')
    try {
      const before = countParagraphs(editor)
      normalizeEmptyListItems(editor)
      const after = countParagraphs(editor)

      expect(before).toBe(1)
      expect(after).toBe(1)
      expect(editor.state.doc.firstChild?.textContent).toBe('Line one\nLine two\nLine three')
    } finally {
      editor.destroy()
    }
  })

  it('round-trips a hard-wrapped paragraph without blank-line expansion', () => {
    const disk = 'Line one\nLine two'
    const serialized = simulateOnCreate(disk)

    expect(trimEnd(serialized)).toBe(trimEnd(disk))
  })

  it('does not modify content without soft breaks', () => {
    const editor = createEditor('# Title\n\nBody text')
    try {
      const docBefore = editor.state.doc.toJSON()
      normalizeEmptyListItems(editor)
      const docAfter = editor.state.doc.toJSON()

      expect(docAfter).toEqual(docBefore)
    } finally {
      editor.destroy()
    }
  })
})

// -----------------------------------------------------------------------
// 3. Rich editor content sync must ignore its own mount-time round-trip
//    differences, but still accept genuine external file changes.
// -----------------------------------------------------------------------
describe('content sync gating', () => {
  it('does not re-sync on mount when only the normalized markdown differs', () => {
    const disk = 'Line one\nLine two'
    const normalizedMarkdown = simulateOnCreate(disk)

    expect(shouldSyncPropIntoEditor(normalizedMarkdown, disk, disk)).toBe(false)
  })

  it('does re-sync when disk content actually changes externally', () => {
    const oldDisk = 'Line one\nLine two'
    const newDisk = 'Line one\nLine two\nLine three'
    const normalizedCurrentMarkdown = simulateOnCreate(oldDisk)

    expect(shouldSyncPropIntoEditor(normalizedCurrentMarkdown, newDisk, oldDisk)).toBe(true)
  })
})

// -----------------------------------------------------------------------
// 4. Actual user edits must still be detected as dirty.
// -----------------------------------------------------------------------
describe('real edits are detected as dirty', () => {
  it('ProseMirror transaction produces a dirty diff', () => {
    const diskContent = '# README\n\nOriginal text'
    const editor = createEditor(diskContent)
    try {
      normalizeEmptyListItems(editor)

      // Insert text via a ProseMirror transaction (no DOM required)
      const { tr } = editor.state
      const insertPos = editor.state.doc.content.size - 1
      editor.view.dispatch(tr.insertText(' added', insertPos))

      const editedMarkdown = editor.getMarkdown()
      expect(trimEnd(editedMarkdown)).not.toBe(trimEnd(diskContent))
    } finally {
      editor.destroy()
    }
  })

  it('deleting content produces a dirty diff', () => {
    const diskContent = '# Title\n\nParagraph to keep\n\nParagraph to delete'
    const editor = createEditor(diskContent)
    try {
      normalizeEmptyListItems(editor)

      // Delete the last paragraph node
      const doc = editor.state.doc
      const lastChild = doc.lastChild!
      const from = doc.content.size - lastChild.nodeSize
      const to = doc.content.size
      editor.view.dispatch(editor.state.tr.delete(from, to))

      const editedMarkdown = editor.getMarkdown()
      expect(trimEnd(editedMarkdown)).not.toBe(trimEnd(diskContent))
    } finally {
      editor.destroy()
    }
  })
})

function countParagraphs(editor: Editor): number {
  let count = 0
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      count++
    }
  })
  return count
}
