// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { normalizeEmptyListItems, normalizeSoftBreaks } from './rich-markdown-normalize'

const showCutLimitErrorMock = vi.hoisted(() => vi.fn())

vi.mock('./rich-markdown-source-owning-cut-feedback', () => ({
  showRichMarkdownSourceOwningCutLimitError: showCutLimitErrorMock
}))

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
  createIsolatedMarkdownExtensionForTests()
]

function createEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: testExtensions,
    content: markdown,
    contentType: 'markdown'
  })
}

afterEach(() => {
  showCutLimitErrorMock.mockReset()
  vi.restoreAllMocks()
})

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

function createClipboardEventMock(options?: { failReadback?: boolean }): {
  data: Map<string, string>
  event: ClipboardEvent
  preventDefault: ReturnType<typeof vi.fn>
} {
  const data = new Map<string, string>()
  const preventDefault = vi.fn()
  const event = {
    clipboardData: {
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value)
      }),
      getData: options?.failReadback
        ? vi.fn(() => '')
        : vi.fn((type: string) => data.get(type) ?? '')
    },
    preventDefault
  } as unknown as ClipboardEvent

  return { data, event, preventDefault }
}

describe('rich markdown cut handler behavior', () => {
  it('hard-wrapped document prose stays one paragraph after normalization', () => {
    const editor = createEditor('Line one\nLine two\nLine three\n')

    expect(countParagraphs(editor)).toBe(1)
    expect(editor.state.doc.firstChild!.textContent).toContain('\n')

    normalizeEmptyListItems(editor)

    expect(countParagraphs(editor)).toBe(1)
    expect(editor.state.doc.firstChild!.textContent).toBe('Line one\nLine two\nLine three')

    editor.destroy()
  })

  it('soft-break normalization still creates visible paragraph breaks', () => {
    const editor = createEditor('Line one\nLine two\nLine three\n')
    normalizeSoftBreaks(editor)

    expect(countParagraphs(editor)).toBe(3)
    const paragraphs: string[] = []
    editor.state.doc.forEach((node) => {
      if (node.type.name === 'paragraph') {
        expect(node.textContent).not.toContain('\n')
        paragraphs.push(node.textContent)
      }
    })
    expect(paragraphs).toEqual(['Line one', 'Line two', 'Line three'])

    editor.destroy()
  })

  it('Cmd+X cuts only a visual line inside a hard-wrapped paragraph', () => {
    const editor = createEditor('Alpha segment stays\nMiddle segment is cut\nOmega segment stays')
    try {
      normalizeEmptyListItems(editor)
      expect(countParagraphs(editor)).toBe(1)

      const text = editor.state.doc.firstChild!.textContent
      const paraStart = 1
      const paraEnd = paraStart + text.length
      const lineFrom = paraStart + text.indexOf('Middle')
      const nextLineFrom = paraStart + text.indexOf('Omega')
      const cursorPos = lineFrom + 'Middle'.length

      let viewState = editor.state.apply(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cursorPos))
      )

      const paragraphElement = document.createElement('p')
      vi.spyOn(paragraphElement, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 20, y: 0, width: 600, height: 60 })
      )
      const view = {
        get state() {
          return viewState
        },
        dispatch: vi.fn((tr) => {
          viewState = viewState.apply(tr)
        }),
        domAtPos: vi.fn(() => ({ node: paragraphElement, offset: 0 })),
        coordsAtPos: vi.fn((pos: number) => {
          if (pos === paraStart) {
            return { top: 0, bottom: 20, left: 20, right: 20 }
          }
          if (pos === paraEnd) {
            return { top: 40, bottom: 60, left: 280, right: 280 }
          }
          return { top: 20, bottom: 40, left: 120, right: 120 }
        }),
        posAtCoords: vi.fn((coords: { top: number }) => {
          return { pos: coords.top < 40 ? lineFrom : nextLineFrom, inside: -1 }
        })
      } as unknown as EditorView

      const clipboard = createClipboardEventMock()
      const handled = handleRichMarkdownCut(view, clipboard.event)

      expect(handled).toBe(true)
      expect(clipboard.preventDefault).toHaveBeenCalled()
      expect(clipboard.data.get('text/plain')).toBe('Middle segment is cut\n')
      expect(view.state.doc.firstChild!.textContent).toBe(
        'Alpha segment stays\nOmega segment stays'
      )
      let paragraphCount = 0
      view.state.doc.forEach((node) => {
        if (node.type.name === 'paragraph') {
          paragraphCount++
        }
      })
      expect(paragraphCount).toBe(1)
    } finally {
      editor.destroy()
    }
  })

  it('surfaces cut-limit feedback when clipboard readback fails', () => {
    const editor = createEditor('Body text to cut.\n')
    try {
      const pos = 1
      let viewState = editor.state.apply(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      )
      const view = {
        get state() {
          return viewState
        },
        dispatch: vi.fn((tr) => {
          viewState = viewState.apply(tr)
        }),
        domAtPos: vi.fn(() => ({ node: document.createElement('p'), offset: 0 })),
        coordsAtPos: vi.fn(() => ({ top: 0, bottom: 20, left: 0, right: 20 })),
        posAtCoords: vi.fn(() => null)
      } as unknown as EditorView

      const clipboard = createClipboardEventMock({ failReadback: true })
      const handled = handleRichMarkdownCut(view, clipboard.event)

      expect(handled).toBe(true)
      expect(clipboard.preventDefault).toHaveBeenCalled()
      expect(showCutLimitErrorMock).toHaveBeenCalledTimes(1)
      expect(view.dispatch).not.toHaveBeenCalled()
      expect(view.state.doc.textContent).toBe('Body text to cut.')
    } finally {
      editor.destroy()
    }
  })

  it('normalizeEmptyListItems is idempotent on already-clean documents', () => {
    const editor = createEditor('First.\n\nSecond.\n\nThird.\n')

    const docBefore = editor.state.doc.toJSON()
    normalizeEmptyListItems(editor)
    const docAfter = editor.state.doc.toJSON()

    // Already separated paragraphs should not be modified
    expect(docAfter).toEqual(docBefore)

    editor.destroy()
  })

  it('normalizeEmptyListItems does not modify populated list items or blockquotes', () => {
    const editor = createEditor('- Item 1\n- Item 2\n')

    const docBefore = editor.state.doc.toJSON()
    normalizeEmptyListItems(editor)
    const docAfter = editor.state.doc.toJSON()

    // List structure should be unchanged (no top-level paragraphs to split)
    expect(docAfter).toEqual(docBefore)

    editor.destroy()
  })
})
