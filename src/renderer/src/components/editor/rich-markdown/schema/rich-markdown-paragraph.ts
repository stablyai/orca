import type { MarkdownParseHelpers, MarkdownParseResult, MarkdownToken } from '@tiptap/core'
import { Paragraph } from '@tiptap/extension-paragraph'

type ParagraphMarkdownParser = (
  token: MarkdownToken,
  helpers: MarkdownParseHelpers
) => MarkdownParseResult

const baseParseMarkdown = Paragraph.config.parseMarkdown as ParagraphMarkdownParser | undefined

export const RichMarkdownParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? []
    // Keep lone inline images inside paragraphs; use the same safe parser if an upstream upgrade removes baseParseMarkdown.
    if (!baseParseMarkdown || (tokens.length === 1 && tokens[0]?.type === 'image')) {
      return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens))
    }
    return baseParseMarkdown(token, helpers)
  }
})
