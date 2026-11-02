// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

function closeMarkdownEditor() {
  const source = Array.from(
    { length: 100 },
    (_, index) => `_Block ${index} ${'x'.repeat(1024)}_`
  ).join('\n\n')
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  const closed = { editor: new WeakRef(editor), document: new WeakRef(editor.state.doc) }
  editor.destroy()
  return closed
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

it('releases the destroyed Markdown editor after the last rich editor closes', async () => {
  const closed = closeMarkdownEditor()
  await collect()
  expect(closed.editor.deref()).toBeUndefined()
  expect(closed.document.deref()).toBeUndefined()
})
