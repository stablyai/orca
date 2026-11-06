// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { CellSelection } from '@tiptap/pm/tables'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusRichMarkdownEditorFromSearch } from './rich-markdown-search-focus'

function findTextPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos
      return false
    }
    return true
  })
  if (position === null) {
    throw new Error(`Expected editor text: ${text}`)
  }
  return position
}

function createSurface(content: string) {
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  document.body.append(root)
  const editor = new Editor({ extensions: [StarterKit, TableKit], content })
  root.append(editor.view.dom)
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  const input = document.createElement('input')
  search.append(input)
  root.append(search)
  root.addEventListener('mousedown', (event) => {
    if (event instanceof MouseEvent) {
      focusRichMarkdownEditorFromSearch(event, editor.view)
    }
  })
  return { editor, input }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Find focus with editor-owned selection', () => {
  it('restores the remembered caret before Shift click when Find owns the native selection', () => {
    vi.useFakeTimers()
    const { editor, input } = createSurface('<p>first</p><p>lower caret</p>')
    const caret = findTextPosition(editor, 'lower caret') + 6
    const updates = vi.fn()
    editor.on('update', updates)
    try {
      editor.commands.setTextSelection(caret)
      input.focus()
      document.getSelection()?.removeAllRanges()
      const paragraph = editor.view.dom.querySelector('p:last-child')
      const text = paragraph?.firstChild
      if (!paragraph || !text) {
        throw new Error('Expected lower paragraph text')
      }
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: caret, inside: -1 })
      const originalDoc = editor.state.doc
      const selection = editor.state.selection
      const event = new MouseEvent('mousedown', {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })

      paragraph.dispatchEvent(event)

      expect(document.activeElement).toBe(editor.view.dom)
      expect(document.getSelection()?.anchorNode).toBe(text)
      expect(document.getSelection()?.anchorOffset).toBe(6)
      expect(document.getSelection()?.focusOffset).toBe(6)
      expect(event.defaultPrevented).toBe(false)

      vi.advanceTimersByTime(20)

      expect(editor.state.selection).toBe(selection)
      expect(editor.state.doc).toBe(originalDoc)
      expect(updates).not.toHaveBeenCalled()
    } finally {
      editor.destroy()
    }
  })

  it('focuses a handled cross-cell selection and preserves its cells without marking content dirty', () => {
    vi.useFakeTimers()
    const { editor, input } = createSurface(
      '<table><tbody><tr><td>first</td><td>second</td></tr></tbody></table>'
    )
    const updates = vi.fn()
    try {
      editor.commands.setTextSelection(findTextPosition(editor, 'first'))
      editor.on('update', updates)
      input.focus()
      const secondPos = findTextPosition(editor, 'second')
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: secondPos, inside: secondPos })
      const second = editor.view.dom.querySelector('td:last-child p')
      if (!second) {
        throw new Error('Expected second table cell')
      }
      const originalDoc = editor.state.doc
      const event = new MouseEvent('mousedown', {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })

      second.dispatchEvent(event)

      const selection = editor.state.selection
      expect(selection).toBeInstanceOf(CellSelection)
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(editor.view.dom)
      expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
      expect(editor.view.dom.classList.contains('ProseMirror-hideselection')).toBe(true)
      expect(document.getSelection()?.rangeCount).toBe(1)

      vi.advanceTimersByTime(20)

      expect(editor.state.selection).toBe(selection)
      expect(editor.state.doc).toBe(originalDoc)
      expect(updates).not.toHaveBeenCalled()
      expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
    } finally {
      editor.destroy()
    }
  })
})
