import { Markdown } from '@tiptap/markdown'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

export function createIsolatedMarkdownExtensionForTests() {
  return Markdown.configure({
    marked: createRichMarkdownEditorCodec().marked,
    markedOptions: { gfm: true }
  })
}
