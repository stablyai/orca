import type { MarkdownTokenizer } from '@tiptap/core'
import { InlineMath } from '@tiptap/extension-mathematics'

// Why: the common dialect requires a non-space next to each delimiter and forbids a
// newline inside, which is what keeps `US$ 5,000 and R$ 40,000` out of a math span.
const INLINE_MATH = /^\$(?![\s$])((?:[^$\n]*[^\s$])?)\$(?!\$)/

const baseTokenizer = InlineMath.config.markdownTokenizer as MarkdownTokenizer

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
