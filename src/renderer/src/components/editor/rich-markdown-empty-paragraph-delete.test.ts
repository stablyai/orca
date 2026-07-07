import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { deleteAdjacentEmptyParagraph } from './rich-markdown-empty-paragraph-delete'

const extensions = [StarterKit, Markdown.configure({ markedOptions: { gfm: true } })]

const hardWrappedMarkdown =
  'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
  'chat owns conversion, ordering, and transcript reconciliation.\n\n' +
  '## Next section'

const hardWrappedTwoParagraphs =
  'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
  'chat owns conversion, ordering, and transcript reconciliation.\n\n' +
  'Second paragraph starts here.'

const headingBeforeHardWrappedParagraph =
  '## Existing section\n\n' +
  'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
  'chat owns conversion, ordering, and transcript reconciliation.'

function createEditor(content = hardWrappedMarkdown): Editor {
  return new Editor({
    element: null,
    extensions,
    content,
    contentType: 'markdown'
  })
}

function findNodeTextPosition(
  editor: Editor,
  nodeName: string,
  textNeedle: string
): { from: number; to: number } {
  let result: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === nodeName && node.textContent.includes(textNeedle)) {
      result = { from: pos + 1, to: pos + node.nodeSize - 1 }
      return false
    }
    return true
  })

  if (!result) {
    throw new Error(`Could not find ${nodeName} containing ${textNeedle}`)
  }

  return result
}

function countHardBreaks(editor: Editor): number {
  let count = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'hardBreak') {
      count += 1
    }
  })
  return count
}

function expectHardWrappedParagraphPreserved(editor: Editor): void {
  expect(countHardBreaks(editor)).toBe(0)
  expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
  expect(editor.state.doc.firstChild?.textContent).toBe(
    'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
      'chat owns conversion, ordering, and transcript reconciliation.'
  )
  expect(editor.getMarkdown().trimEnd()).toBe(hardWrappedMarkdown)
}

function expectNoHardBreaks(editor: Editor): void {
  expect(countHardBreaks(editor)).toBe(0)
}

describe('rich markdown empty paragraph deletion', () => {
  it('Backspace in an inserted empty paragraph preserves soft-wrapped prose', () => {
    const editor = createEditor()
    try {
      const paragraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(paragraph.to)
      expect(editor.commands.splitBlock()).toBe(true)

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectHardWrappedParagraphPreserved(editor)
    } finally {
      editor.destroy()
    }
  })

  it('Backspace at the next block start removes a previous empty paragraph without joining', () => {
    const editor = createEditor()
    try {
      const paragraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(paragraph.to)
      expect(editor.commands.splitBlock()).toBe(true)

      const heading = findNodeTextPosition(editor, 'heading', 'Next section')
      editor.commands.setTextSelection(heading.from)

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectHardWrappedParagraphPreserved(editor)
    } finally {
      editor.destroy()
    }
  })

  it('Delete at a soft-wrapped paragraph end removes the following empty paragraph', () => {
    const editor = createEditor()
    try {
      const paragraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(paragraph.to)
      expect(editor.commands.splitBlock()).toBe(true)
      editor.commands.setTextSelection(paragraph.to)

      expect(deleteAdjacentEmptyParagraph(editor, 'forward')).toBe(true)

      expectHardWrappedParagraphPreserved(editor)
    } finally {
      editor.destroy()
    }
  })

  it('Delete in an empty paragraph before soft-wrapped prose preserves soft newlines', () => {
    const editor = createEditor(`\n\n${hardWrappedMarkdown}`)
    try {
      editor.commands.setTextSelection(1)

      expect(deleteAdjacentEmptyParagraph(editor, 'forward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.firstChild?.textContent).toBe(
        'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
          'chat owns conversion, ordering, and transcript reconciliation.'
      )
    } finally {
      editor.destroy()
    }
  })

  it('Backspace after deleting slash text in an empty command paragraph preserves soft newlines', () => {
    const editor = createEditor()
    try {
      const paragraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(paragraph.to)
      expect(editor.commands.splitBlock()).toBe(true)
      const slashPos = editor.state.selection.from
      editor.view.dispatch(editor.state.tr.insertText('/', slashPos))
      editor.view.dispatch(editor.state.tr.delete(slashPos, slashPos + 1))

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectHardWrappedParagraphPreserved(editor)
    } finally {
      editor.destroy()
    }
  })

  it('Backspace joining two non-empty paragraphs preserves source soft newlines', () => {
    const editor = createEditor(hardWrappedTwoParagraphs)
    try {
      const secondParagraph = findNodeTextPosition(editor, 'paragraph', 'Second paragraph')
      editor.commands.setTextSelection(secondParagraph.from)

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.childCount).toBe(1)
      expect(editor.state.doc.firstChild?.textContent).toBe(
        'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
          'chat owns conversion, ordering, and transcript reconciliation.Second paragraph starts here.'
      )
    } finally {
      editor.destroy()
    }
  })

  it('Delete joining two non-empty paragraphs preserves source soft newlines', () => {
    const editor = createEditor(hardWrappedTwoParagraphs)
    try {
      const firstParagraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(firstParagraph.to)

      expect(deleteAdjacentEmptyParagraph(editor, 'forward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.childCount).toBe(1)
      expect(editor.state.doc.firstChild?.textContent).toBe(
        'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
          'chat owns conversion, ordering, and transcript reconciliation.Second paragraph starts here.'
      )
    } finally {
      editor.destroy()
    }
  })

  it('Backspace joining a following heading preserves source soft newlines', () => {
    const editor = createEditor()
    try {
      const heading = findNodeTextPosition(editor, 'heading', 'Next section')
      editor.commands.setTextSelection(heading.from)

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.childCount).toBe(1)
      expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
      expect(editor.state.doc.firstChild?.textContent).toBe(
        'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
          'chat owns conversion, ordering, and transcript reconciliation.Next section'
      )
    } finally {
      editor.destroy()
    }
  })

  it('Delete joining a following heading preserves source soft newlines', () => {
    const editor = createEditor()
    try {
      const firstParagraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(firstParagraph.to)

      expect(deleteAdjacentEmptyParagraph(editor, 'forward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.childCount).toBe(1)
      expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
      expect(editor.state.doc.firstChild?.textContent).toBe(
        'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
          'chat owns conversion, ordering, and transcript reconciliation.Next section'
      )
    } finally {
      editor.destroy()
    }
  })

  it('Backspace joining from a previous heading preserves source soft newlines', () => {
    const editor = createEditor(headingBeforeHardWrappedParagraph)
    try {
      const paragraph = findNodeTextPosition(editor, 'paragraph', 'launch-lifetime')
      editor.commands.setTextSelection(paragraph.from)

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.childCount).toBe(2)
      expect(editor.state.doc.child(0).type.name).toBe('heading')
      expect(editor.state.doc.child(0).textContent).toBe(
        'Existing sectionAlpha owns launch-lifetime state keyed by tab id, while native'
      )
      expect(editor.state.doc.child(1).type.name).toBe('paragraph')
      expect(editor.state.doc.child(1).textContent).toBe(
        'chat owns conversion, ordering, and transcript reconciliation.'
      )
      expect(editor.getMarkdown()).not.toContain('  \n')
    } finally {
      editor.destroy()
    }
  })

  it('Delete joining from a previous heading preserves source soft newlines', () => {
    const editor = createEditor(headingBeforeHardWrappedParagraph)
    try {
      const heading = findNodeTextPosition(editor, 'heading', 'Existing section')
      editor.commands.setTextSelection(heading.to)

      expect(deleteAdjacentEmptyParagraph(editor, 'forward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.childCount).toBe(2)
      expect(editor.state.doc.child(0).type.name).toBe('heading')
      expect(editor.state.doc.child(0).textContent).toBe(
        'Existing sectionAlpha owns launch-lifetime state keyed by tab id, while native'
      )
      expect(editor.state.doc.child(1).type.name).toBe('paragraph')
      expect(editor.state.doc.child(1).textContent).toBe(
        'chat owns conversion, ordering, and transcript reconciliation.'
      )
      expect(editor.getMarkdown()).not.toContain('  \n')
    } finally {
      editor.destroy()
    }
  })

  it('works inside blockquotes without converting soft newlines to hard breaks', () => {
    const editor = createEditor(
      '> Alpha owns launch-lifetime state keyed by tab id, while native\n' +
        '> chat owns conversion, ordering, and transcript reconciliation.\n' +
        '>\n' +
        '> Second paragraph starts here.'
    )
    try {
      const secondParagraph = findNodeTextPosition(editor, 'paragraph', 'Second paragraph')
      editor.commands.setTextSelection(secondParagraph.from)

      expect(deleteAdjacentEmptyParagraph(editor, 'backward')).toBe(true)

      expectNoHardBreaks(editor)
      expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(
        'Alpha owns launch-lifetime state keyed by tab id, while native\n' +
          'chat owns conversion, ordering, and transcript reconciliation.Second paragraph starts here.'
      )
    } finally {
      editor.destroy()
    }
  })
})
