// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import { DOMParser } from '@tiptap/pm/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'

const showCutLimitError = vi.hoisted(() => vi.fn())
vi.mock('./rich-markdown-source-owning-cut-feedback', () => ({
  showRichMarkdownSourceOwningCutLimitError: showCutLimitError
}))

const editors: Editor[] = []

function createEditor(content: string | JSONContent): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {})
  })
  editors.push(editor)
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 0, bottom: 20, left: 0, right: 20 })
  return editor
}

function clipboard() {
  const data = new DataTransfer()
  data.setData('text/plain', 'existing clipboard')
  data.setData('text/html', '<p>existing clipboard</p>')
  const event = new ClipboardEvent('cut', { clipboardData: data, cancelable: true })
  return { data, event }
}

function imagePosition(editor: Editor) {
  let position: number | undefined
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      position = pos
    }
  })
  if (position === undefined) {
    throw new Error('Image missing')
  }
  return position
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  showCutLimitError.mockReset()
  vi.restoreAllMocks()
})

describe('cutting Markdown images with an empty caret selection', () => {
  it.each([1, 2])('writes a restorable image before deleting its paragraph at caret %s', (pos) => {
    const editor = createEditor('![](image.png)')
    editor.commands.setTextSelection(pos)
    const { data, event } = clipboard()
    expect(handleRichMarkdownCut(editor.view, event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(data.getData('text/html')).toContain('image.png')
    expect(data.getData('text/plain')).toBe('')
    expect(editor.getMarkdown()).toBe('')
    const container = document.createElement('div')
    container.innerHTML = data.getData('text/html')
    const restored = DOMParser.fromSchema(editor.schema).parse(container)
    const images: string[] = []
    restored.descendants((node) => {
      if (node.type.name === 'image') {
        images.push(node.attrs.src)
      }
    })
    expect(images).toEqual(['image.png'])
    restored.check()
    editor.state.doc.check()
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getMarkdown()).toBe('![](image.png)')
  })

  it('leaves the image intact when no clipboard is available', () => {
    const editor = createEditor('![](image.png)')
    editor.commands.setTextSelection(1)
    const before = editor.getJSON()
    const event = new ClipboardEvent('cut', { cancelable: true })
    expect(handleRichMarkdownCut(editor.view, event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })

  it('leaves the image intact and reports failure when the clipboard rejects the write', () => {
    const editor = createEditor('![](image.png)')
    editor.commands.setTextSelection(1)
    const before = editor.getJSON()
    const { data, event } = clipboard()
    vi.spyOn(data, 'setData').mockImplementation(() => {})
    expect(handleRichMarkdownCut(editor.view, event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(editor.getJSON()).toEqual(before)
    expect(data.getData('text/plain')).toBe('existing clipboard')
    expect(showCutLimitError).toHaveBeenCalledTimes(1)
  })

  it.each([
    '- ![](image.png)\n- Keep this item',
    '- [ ] ![](image.png)\n- [ ] Keep this item',
    '| Image | Keep |\n| --- | --- |\n| ![](image.png) | Keep this cell |'
  ])('serializes an image nested in a list or table without deleting its neighbor', (source) => {
    const editor = createEditor(source)
    editor.commands.setTextSelection(imagePosition(editor))
    const { data, event } = clipboard()
    expect(handleRichMarkdownCut(editor.view, event)).toBe(true)
    expect(data.getData('text/html')).toContain('image.png')
    expect(editor.getMarkdown()).not.toContain('image.png')
    expect(editor.getMarkdown()).toContain('Keep this')
    editor.state.doc.check()
  })
})

describe('empty and textual block cut compatibility', () => {
  it('deletes a truly empty paragraph without overwriting the clipboard', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }
      ]
    })
    editor.commands.setTextSelection(1)
    const { data, event } = clipboard()
    expect(handleRichMarkdownCut(editor.view, event)).toBe(true)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.textContent).toBe('Keep')
    expect(data.getData('text/plain')).toBe('existing clipboard')
    expect(data.getData('text/html')).toBe('<p>existing clipboard</p>')
  })

  it.each([
    { listType: 'bulletList', itemType: 'listItem' },
    { listType: 'taskList', itemType: 'taskItem' }
  ])('deletes an empty $itemType without overwriting the clipboard', ({ listType, itemType }) => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: listType,
          content: [
            { type: itemType, content: [{ type: 'paragraph' }] },
            {
              type: itemType,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }]
            }
          ]
        }
      ]
    })
    editor.commands.setTextSelection(3)
    const { data, event } = clipboard()
    expect(handleRichMarkdownCut(editor.view, event)).toBe(true)
    expect(editor.state.doc.firstChild?.childCount).toBe(1)
    expect(editor.state.doc.textContent).toBe('Keep')
    expect(data.getData('text/plain')).toBe('existing clipboard')
    expect(data.getData('text/html')).toBe('<p>existing clipboard</p>')
    editor.state.doc.check()
  })

  it.each([
    { content: [{ type: 'hardBreak' }], expected: '\n' },
    { content: [{ type: 'text', text: '   ' }], expected: '   ' }
  ])('preserves the existing clipboard behavior for $expected', ({ content, expected }) => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content },
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }
      ]
    })
    editor.commands.setTextSelection(1)
    const { data, event } = clipboard()
    expect(handleRichMarkdownCut(editor.view, event)).toBe(true)
    expect(data.getData('text/plain')).toBe(expected)
    expect(editor.state.doc.textContent).toBe('Keep')
    editor.state.doc.check()
  })
})
