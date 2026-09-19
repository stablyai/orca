import { InlineMath } from '@tiptap/extension-mathematics'

// Keep money as text while allowing valid multiline and escaped LaTeX content.
const INLINE_MATH = /^\$(?![\s$])((?:\\[\s\S]|[^$\\])*?)(?<!\s)\$(?![\d$])/

const baseTokenizer = InlineMath.config.markdownTokenizer
if (!baseTokenizer) {
  throw new Error('InlineMath must provide a Markdown tokenizer')
}

export const RichMarkdownInlineMath = InlineMath.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src) {
      const match = src.match(INLINE_MATH)
      if (!match) {
        return undefined
      }
      return {
        type: 'inlineMath',
        raw: match[0],
        latex: match[1]
      }
    }
  }
})
