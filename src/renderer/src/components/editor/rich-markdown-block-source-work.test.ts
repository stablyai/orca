import { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

function create(source: string) {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: source,
    contentType: 'markdown'
  })
}

it('proves the assembled document without reparsing every unchanged source block', () => {
  const source = `${Array.from(
    { length: 1000 },
    (_, index) => `Paragraph ${index} with _emphasis_.\n\n> [!NOTE]\n> - Callout ${index}\n\n`
  ).join('')}End\n`
  const editor = create(source)
  const refs = {
    originalSourceRef: { current: source },
    baseCanonicalRef: { current: editor.getMarkdown() },
    lastCommittedMarkdownRef: { current: source }
  }
  const parse = vi.spyOn(editor.markdown!, 'parse')
  let expected = source
  try {
    for (let edit = 0; edit < 3; edit++) {
      parse.mockClear()
      editor.commands.insertContentAt(1, { type: 'text', text: 'x' })
      expected = `x${expected}`
      const result = commitRichMarkdownSerialization(editor, refs, (markdown) => {
        const reopened = create(markdown)
        try {
          return reopened.getMarkdown()
        } finally {
          reopened.destroy()
        }
      })
      expect(result.markdown).toBe(expected)
      expect(parse.mock.calls.filter(([markdown]) => markdown.length > 50_000)).toHaveLength(
        edit === 0 ? 2 : 1
      )
      expect(parse.mock.calls.length).toBeLessThanOrEqual(3)
    }
  } finally {
    parse.mockRestore()
    editor.destroy()
  }
})
