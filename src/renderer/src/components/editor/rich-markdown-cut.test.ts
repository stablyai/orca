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
import { normalizeSoftBreaks } from './rich-markdown-normalize'

/**
 * Minimal extensions matching the rich editor schema without UI dependencies.
 */
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

/**
 * Simulates the cut handler's depth walk to determine what node would be cut.
 * This mirrors the logic in RichMarkdownEditor.tsx handleDOMEvents.cut,
 * including the depth < 1 guard.
 */
function simulateCut(
  editor: Editor,
  pos: number
): {
  depth: number
  cutDepth: number
  cutNodeType: string
  cutText: string
  path: string[]
  wouldBail: boolean
} {
  const $from = editor.state.doc.resolve(pos)
  const path: string[] = []
  for (let d = 0; d <= $from.depth; d++) {
    path.push($from.node(d).type.name)
  }

  // Mirror the depth < 1 guard from the real handler
  if ($from.depth < 1) {
    return {
      depth: $from.depth,
      cutDepth: 0,
      cutNodeType: $from.node(0).type.name,
      cutText: $from.node(0).textContent,
      path,
      wouldBail: true
    }
  }

  let cutDepth = $from.depth
  for (let d = $from.depth - 1; d >= 1; d--) {
    const name = $from.node(d).type.name
    if (name === 'listItem' || name === 'taskItem') {
      cutDepth = d
      break
    }
    if (name === 'tableCell' || name === 'tableHeader') {
      break
    }
  }

  const cutNode = $from.node(cutDepth)
  return {
    depth: $from.depth,
    cutDepth,
    cutNodeType: cutNode.type.name,
    cutText: cutNode.textContent,
    path,
    wouldBail: false
  }
}

/** Count top-level paragraph nodes in the document. */
function countParagraphs(editor: Editor): number {
  let count = 0
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      count++
    }
  })
  return count
}

describe('rich markdown cut handler behavior', () => {
  it('heading + paragraph: cuts only the paragraph', () => {
    const editor = createEditor('# Title\n\nBody text here.\n')

    // Find position inside the paragraph
    const doc = editor.state.doc
    let paraPos = -1
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph') {
        paraPos = offset + 1
      }
    })

    const result = simulateCut(editor, paraPos)

    expect(result.cutNodeType).toBe('paragraph')
    expect(result.cutText).toBe('Body text here.')
    editor.destroy()
  })

  it('multi-line markdown (no blank separator): after normalization, each line is a separate paragraph', () => {
    const editor = createEditor('Line one\nLine two\nLine three\n')

    // Before normalization: single paragraph with \n chars
    expect(countParagraphs(editor)).toBe(1)
    expect(editor.state.doc.firstChild!.textContent).toContain('\n')

    // Normalize: splits the single paragraph into three
    normalizeSoftBreaks(editor)

    // After normalization: three separate paragraph nodes
    expect(countParagraphs(editor)).toBe(3)

    // Each paragraph is its own line — no \n inside any of them
    const paragraphs: string[] = []
    editor.state.doc.forEach((node) => {
      if (node.type.name === 'paragraph') {
        expect(node.textContent).not.toContain('\n')
        paragraphs.push(node.textContent)
      }
    })
    expect(paragraphs).toEqual(['Line one', 'Line two', 'Line three'])

    // Cmd+X on the first paragraph only cuts "Line one", not all three lines
    const result = simulateCut(editor, 1)
    expect(result.cutNodeType).toBe('paragraph')
    expect(result.cutText).toBe('Line one')

    editor.destroy()
  })

  it('multi-line: Cmd+X on second line only cuts that line after normalization', () => {
    const editor = createEditor('Line one\nLine two\nLine three\n')
    normalizeSoftBreaks(editor)

    // Find the second paragraph ("Line two")
    const doc = editor.state.doc
    let secondParaPos = -1
    let count = 0
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph') {
        count++
        if (count === 2) {
          secondParaPos = offset + 1
        }
      }
    })

    expect(secondParaPos).toBeGreaterThan(0)
    const result = simulateCut(editor, secondParaPos)
    expect(result.cutNodeType).toBe('paragraph')
    expect(result.cutText).toBe('Line two')

    editor.destroy()
  })

  it('paragraphs separated by blank lines are separate blocks', () => {
    const editor = createEditor('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n')

    // Find second paragraph
    const doc = editor.state.doc
    let secondParaPos = -1
    let count = 0
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph') {
        count++
        if (count === 2) {
          secondParaPos = offset + 1
        }
      }
    })

    const result = simulateCut(editor, secondParaPos)

    expect(result.cutNodeType).toBe('paragraph')
    expect(result.cutText).toBe('Second paragraph.')
    editor.destroy()
  })

  it('list item: cuts the entire list item', () => {
    const editor = createEditor('- Item 1\n- Item 2\n- Item 3\n')

    // Find position inside second list item's paragraph
    const doc = editor.state.doc
    let secondItemPos = -1
    let listItemCount = 0
    doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && secondItemPos === -1) {
        // Check if parent path includes listItem
        const $pos = doc.resolve(pos + 1)
        for (let d = $pos.depth; d >= 1; d--) {
          if ($pos.node(d).type.name === 'listItem') {
            listItemCount++
            if (listItemCount === 2) {
              secondItemPos = pos + 1
            }
            break
          }
        }
      }
    })

    if (secondItemPos > 0) {
      const result = simulateCut(editor, secondItemPos)
      expect(result.cutNodeType).toBe('listItem')
      expect(result.cutText).toBe('Item 2')
    }

    editor.destroy()
  })

  it('document with horizontal rule: depth < 1 guard prevents crash', () => {
    const editor = createEditor('---\n\nBody text here.\n')

    // Position 0 is before the horizontal rule — depth 0 (GapCursor territory)
    const $pos0 = editor.state.doc.resolve(0)
    expect($pos0.depth).toBe(0)

    // The cut handler should bail out (return false) at depth 0 instead of crashing
    const result = simulateCut(editor, 0)
    expect(result.wouldBail).toBe(true)

    // Paragraph after the hr is still cuttable normally
    const doc = editor.state.doc
    let paraPos = -1
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph') {
        paraPos = offset + 1
      }
    })
    if (paraPos > 0) {
      const safeResult = simulateCut(editor, paraPos)
      expect(safeResult.wouldBail).toBe(false)
      expect(safeResult.cutNodeType).toBe('paragraph')
    }

    editor.destroy()
  })

  it('single paragraph document: cut removes the only content', () => {
    const editor = createEditor('This is the only paragraph.\n')

    const result = simulateCut(editor, 1)

    expect(result.cutNodeType).toBe('paragraph')

    // Check that from/to would encompass the entire doc content
    const $from = editor.state.doc.resolve(1)
    const from = $from.before(result.cutDepth)
    const to = $from.after(result.cutDepth)
    expect(from).toBe(0)
    expect(to).toBe(editor.state.doc.content.size)

    editor.destroy()
  })

  it('blockquote with multiple paragraphs: cuts only one paragraph', () => {
    const editor = createEditor('> Line 1\n>\n> Line 2\n>\n> Line 3\n')

    // Find first paragraph in blockquote
    const doc = editor.state.doc
    let firstParaInBq = -1
    doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && firstParaInBq === -1) {
        const $pos = doc.resolve(pos + 1)
        for (let d = $pos.depth; d >= 1; d--) {
          if ($pos.node(d).type.name === 'blockquote') {
            firstParaInBq = pos + 1
            break
          }
        }
      }
    })

    if (firstParaInBq > 0) {
      const result = simulateCut(editor, firstParaInBq)
      expect(result.cutNodeType).toBe('paragraph')
    }

    editor.destroy()
  })

  it('nested list item: cuts just the inner list item', () => {
    const editor = createEditor('- Item 1\n  - Nested A\n  - Nested B\n- Item 2\n')

    // Find a paragraph inside a nested list item
    const doc = editor.state.doc
    let nestedPos = -1
    doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Nested A' && nestedPos === -1) {
        nestedPos = pos + 1
      }
    })

    if (nestedPos > 0) {
      const result = simulateCut(editor, nestedPos)
      expect(result.cutNodeType).toBe('listItem')
      expect(result.cutText).toBe('Nested A')
    }

    editor.destroy()
  })

  it('list item with nested sublist: cuts parent list item including sublist', () => {
    const editor = createEditor('- Parent item\n  - Child A\n  - Child B\n- Other item\n')

    // Find the paragraph "Parent item"
    const doc = editor.state.doc
    let parentPos = -1
    doc.descendants((node, pos) => {
      if (
        node.type.name === 'paragraph' &&
        node.textContent === 'Parent item' &&
        parentPos === -1
      ) {
        parentPos = pos + 1
      }
    })

    if (parentPos > 0) {
      const result = simulateCut(editor, parentPos)
      expect(result.cutNodeType).toBe('listItem')
    }

    editor.destroy()
  })

  it('normalizeSoftBreaks is idempotent on already-clean documents', () => {
    const editor = createEditor('First.\n\nSecond.\n\nThird.\n')

    const docBefore = editor.state.doc.toJSON()
    normalizeSoftBreaks(editor)
    const docAfter = editor.state.doc.toJSON()

    // Already separated paragraphs should not be modified
    expect(docAfter).toEqual(docBefore)

    editor.destroy()
  })

  it('normalizeSoftBreaks does not modify list items or blockquotes', () => {
    const editor = createEditor('- Item 1\n- Item 2\n')

    const docBefore = editor.state.doc.toJSON()
    normalizeSoftBreaks(editor)
    const docAfter = editor.state.doc.toJSON()

    // List structure should be unchanged (no top-level paragraphs to split)
    expect(docAfter).toEqual(docBefore)

    editor.destroy()
  })
})
