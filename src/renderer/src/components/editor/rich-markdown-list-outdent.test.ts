// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { outdentRichMarkdownListItem } from './rich-markdown-list-indent'

function createEditor(content: string): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 0, bottom: 20, left: 0, right: 0 })
  return editor
}

function itemAtText(editor: Editor, text: string) {
  let result: { position: number; node: ReturnType<typeof editor.state.doc.child> } | undefined
  editor.state.doc.descendants((node, position) => {
    if (
      (node.type.name === 'listItem' || node.type.name === 'taskItem') &&
      node.firstChild?.textContent === text
    ) {
      result = { position, node }
    }
  })
  if (!result) {
    throw new Error(`Expected list item: ${text}`)
  }
  return result
}

describe('mixed list outdent', () => {
  it.each([false, true])(
    'preserves checked tasks after a selected item range (reverse %s)',
    (reverse) => {
      const editor = createEditor('- Parent\n  - [ ] First\n  - [x] Middle\n  - [x] Last')
      try {
        const first = itemAtText(editor, 'First').position + 3
        const middle = itemAtText(editor, 'Middle').position + 4
        const originalLast = itemAtText(editor, 'Last').node.toJSON()
        editor.commands.setTextSelection({
          from: reverse ? middle : first,
          to: reverse ? first : middle
        })
        const before = editor.getJSON()

        expect(outdentRichMarkdownListItem(editor)).toBe(true)

        expect(itemAtText(editor, 'Last').node.toJSON()).toEqual(originalLast)
        for (const text of ['First', 'Middle']) {
          expect(editor.state.doc.resolve(itemAtText(editor, text).position).depth).toBe(1)
        }
        const after = editor.getJSON()
        expect(editor.commands.undo()).toBe(true)
        expect(editor.getJSON()).toEqual(before)
        expect(editor.commands.redo()).toBe(true)
        expect(editor.getJSON()).toEqual(after)
      } finally {
        editor.destroy()
      }
    }
  )

  it.each([
    ['- Parent\n  - [ ] First\n  - [x] Middle\n  - [x] Last', 'First'],
    ['- Parent\n  - [ ] First\n  - [x] Middle\n  - [x] Last', 'Middle'],
    ['- [ ] Parent\n  - First\n  - Middle\n  - **Last**', 'First'],
    ['- [ ] Parent\n  4. First\n  5. Middle\n  6. **Last**', 'Middle']
  ])('preserves the unselected trailing item after outdenting %s at %s', (source, selected) => {
    const editor = createEditor(source)
    try {
      const last = itemAtText(editor, 'Last')
      const originalLast = last.node.toJSON()
      const $originalLast = editor.state.doc.resolve(last.position)
      const originalList = $originalLast.parent
      const originalIndex = $originalLast.index()
      const selectedItem = itemAtText(editor, selected)
      editor.commands.setTextSelection(selectedItem.position + 3)
      const before = editor.getJSON()

      expect(outdentRichMarkdownListItem(editor)).toBe(true)

      const result = itemAtText(editor, 'Last')
      expect(result.node.toJSON()).toEqual(originalLast)
      const $result = editor.state.doc.resolve(result.position)
      const resultList = $result.parent
      expect(resultList.type).toBe(originalList.type)
      expect({ ...resultList.attrs, start: null }).toEqual({ ...originalList.attrs, start: null })
      if (typeof originalList.attrs.start === 'number') {
        expect(resultList.attrs.start + $result.index()).toBe(
          originalList.attrs.start + originalIndex
        )
      }
      const lifted = itemAtText(editor, selected)
      expect(editor.state.doc.resolve(lifted.position).depth).toBe(1)
      const after = editor.getJSON()
      expect(editor.commands.undo()).toBe(true)
      expect(editor.getJSON()).toEqual(before)
      expect(editor.commands.redo()).toBe(true)
      expect(editor.getJSON()).toEqual(after)
    } finally {
      editor.destroy()
    }
  })
})
