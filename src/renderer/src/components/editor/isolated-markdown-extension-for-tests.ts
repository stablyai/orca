import { createRichMarkdownExtension } from './rich-markdown-extension'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

export function createIsolatedMarkdownExtensionForTests() {
  const codec = createRichMarkdownEditorCodec()
  return createRichMarkdownExtension(codec).configure({
    marked: codec.marked,
    markedOptions: { gfm: true }
  })
}
