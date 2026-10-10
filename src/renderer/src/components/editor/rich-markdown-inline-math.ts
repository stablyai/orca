import { InlineMath } from '@tiptap/extension-mathematics'

const tokenizer = InlineMath.config.markdownTokenizer
// Money must not close a formula on whitespace or on the dollar before another amount.
const INLINE_MATH_PATTERN = /^\$(?![\s$])((?:\\[\s\S]|[^$\\])*?)(?<!\s)\$(?![\d$])/

export const RichMarkdownInlineMath = InlineMath.extend({
  markdownTokenizer:
    tokenizer && typeof tokenizer !== 'function'
      ? {
          ...tokenizer,
          tokenize: (source: string) => {
            const match = INLINE_MATH_PATTERN.exec(source)
            return match ? { type: 'inlineMath', raw: match[0], latex: match[1] } : undefined
          }
        }
      : tokenizer
})
