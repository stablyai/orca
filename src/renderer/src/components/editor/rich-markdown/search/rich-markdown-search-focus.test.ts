// @vitest-environment happy-dom
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusRichMarkdownEditorFromSearch } from './rich-markdown-search-focus'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {}
  }
})

function createSurface() {
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  const editorDom = document.createElement('div')
  editorDom.contentEditable = 'true'
  editorDom.tabIndex = -1
  const paragraph = document.createElement('p')
  paragraph.textContent = 'First editable paragraph'
  editorDom.append(paragraph)
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  const findInput = document.createElement('input')
  const replaceInput = document.createElement('input')
  search.append(findInput, replaceInput)
  root.append(editorDom, search)
  document.body.append(root)
  const focus = vi.spyOn(editorDom, 'focus')
  const viewFocus = vi.fn(() => editorDom.focus({ preventScroll: true }))
  const view = { dom: editorDom, focus: viewFocus, state: EditorState.create({ schema }) }
  root.addEventListener('mousedown', (event) => {
    if (event instanceof MouseEvent) {
      focusRichMarkdownEditorFromSearch(event, view)
    }
  })
  return { root, editorDom, paragraph, findInput, replaceInput, focus, viewFocus }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('rich markdown search focus handoff', () => {
  it.each(['find', 'replace'] as const)(
    'returns keyboard focus from %s without preventing native selection or requesting scroll',
    (field) => {
      const { paragraph, editorDom, findInput, replaceInput, focus, viewFocus } = createSurface()
      const input = field === 'find' ? findInput : replaceInput
      input.focus()
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })

      paragraph.dispatchEvent(event)

      expect(document.activeElement).toBe(editorDom)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(viewFocus).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
    }
  )

  it('restores the editor selection before native Shift click handling', () => {
    const { paragraph, editorDom, findInput, viewFocus } = createSurface()
    findInput.focus()
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      shiftKey: true
    })

    paragraph.dispatchEvent(event)

    expect(document.activeElement).toBe(editorDom)
    expect(viewFocus).toHaveBeenCalledExactlyOnceWith()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not steal focus from a different editor find widget or unrelated field', () => {
    const first = createSurface()
    const second = createSurface()
    const unrelated = document.createElement('input')
    document.body.append(unrelated)

    for (const input of [second.findInput, unrelated]) {
      input.focus()
      first.paragraph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      expect(document.activeElement).toBe(input)
    }

    expect(first.focus).not.toHaveBeenCalled()
  })

  it('allows editable content nested inside an unrelated noneditable ancestor', () => {
    const { root, paragraph, findInput, focus } = createSurface()
    root.setAttribute('contenteditable', 'false')
    findInput.focus()

    paragraph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })
})
