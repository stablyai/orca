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
    // Why: upstream hoists a lone image out of its paragraph, which produces an
    // inline image node directly under `doc` now that images are inline nodes.
    // The missing-base fallback keeps a Tiptap upgrade that drops the field from
    // turning every paragraph parse into a TypeError.
    if (!baseParseMarkdown || (tokens.length === 1 && tokens[0]?.type === 'image')) {
      return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens))
    }
    return baseParseMarkdown(token, helpers)
  }
})
