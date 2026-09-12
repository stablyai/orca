import { Markdown } from '@tiptap/markdown'
import { preserveLiteralMarkdownSource } from './rich-markdown-literal-serialization'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'

export const RichMarkdownExtension = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event)
    // Empty Markdown must initialize without routing through the HTML DOM parser.
    if (
      this.editor.options.contentType === 'markdown' &&
      typeof this.editor.options.content === 'string'
    ) {
      this.editor.options.content = this.editor.schema.topNodeType.createAndFill()!.toJSON()
    }
  }
})

export function createRichMarkdownExtension(
  codec: RichMarkdownEditorCodec,
  htmlSuperscriptLinks = false
) {
  return RichMarkdownExtension.extend({
    onBeforeCreate(event) {
      this.parent?.(event)
      preserveLiteralMarkdownSource(this.editor, codec, htmlSuperscriptLinks)
    }
  })
}
