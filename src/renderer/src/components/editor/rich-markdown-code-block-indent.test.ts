// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { indentRichMarkdownCodeBlock } from './rich-markdown-code-block-indent'

let editor: Editor | null = null

function createMarkdownEditor(markdown: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
  return editor
}

function codeBlockPosition(target: Editor, text: string): number {
  let position = -1
  target.state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock' && node.textContent.includes(text)) {
      position = pos + 1 + node.textContent.indexOf(text)
    }
    return position === -1
  })
  return position
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('indentRichMarkdownCodeBlock', () => {
  it('indents selected code lines without replacing their text, undoable in one step', () => {
    const target = createMarkdownEditor('```js\nconst a = 1\nconst b = 2\nconst c = 3\n```')
    target.commands.setTextSelection({
      from: codeBlockPosition(target, 'const a'),
      to: codeBlockPosition(target, 'const b') + 'const b = 2'.length
    })

    expect(indentRichMarkdownCodeBlock(target)).toBe(true)
    expect(target.getMarkdown()).toBe('```js\n  const a = 1\n  const b = 2\nconst c = 3\n```')
    expect(target.commands.undo()).toBe(true)
    expect(target.getMarkdown()).toBe('```js\nconst a = 1\nconst b = 2\nconst c = 3\n```')
  })

  it('inserts spaces at the caret for an empty selection', () => {
    const target = createMarkdownEditor('```js\nconst x = 1\n```')
    target.commands.setTextSelection(codeBlockPosition(target, 'x'))

    expect(indentRichMarkdownCodeBlock(target)).toBe(true)
    expect(target.getMarkdown()).toBe('```js\nconst   x = 1\n```')
  })
})
