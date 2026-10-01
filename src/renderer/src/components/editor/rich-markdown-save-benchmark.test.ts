import { Editor } from '@tiptap/core'
import { it, expect } from 'vitest'
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
// Run with ORCA_MARKDOWN_SAVE_BENCHMARK=1; timings are evidence, not a machine-dependent CI gate.
it.skipIf(process.env.ORCA_MARKDOWN_SAVE_BENCHMARK !== '1')(
  'measures source preservation at supported document sizes',
  () => {
    for (const count of [100, 500, 1500, 6000]) {
      const source = `${Array.from(
        { length: count },
        (_, i) => `Paragraph ${i} with _emphasis_ and user_name.\n\n> [!NOTE]\n> - Callout ${i}\n\n`
      ).join('')}End\n`
      const editor = create(source)
      const refs = {
        originalSourceRef: { current: source },
        baseCanonicalRef: { current: editor.getMarkdown() },
        lastCommittedMarkdownRef: { current: source }
      }
      const times: number[] = []
      for (let j = 0; j < 3; j++) {
        editor.commands.insertContentAt(2, { type: 'text', text: 'x' })
        const start = performance.now()
        const result = commitRichMarkdownSerialization(editor, refs, (text) => {
          const round = create(text)
          try {
            return round.getMarkdown()
          } finally {
            round.destroy()
          }
        })
        times.push(Math.round(performance.now() - start))
        expect(result.markdown).toContain('> [!NOTE]\n> - Callout 0')
      }
      process.stdout.write(
        `${JSON.stringify({
          bytes: source.length,
          blocks: editor.state.doc.childCount,
          milliseconds: times
        })}\n`
      )
      editor.destroy()
    }
  }
)
