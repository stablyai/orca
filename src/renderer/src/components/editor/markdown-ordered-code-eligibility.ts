import { createTiptapMarkedFacade } from './tiptap-marked-facade'
import { ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'
import { RichMarkdownOrderedList } from './rich-markdown-ordered-list'
import type { MarkdownToken } from '@tiptap/core'
import type { Tokens } from 'marked'

const MARKER = `(?:${ORDERED_LIST_MARKER_PATTERN})[.)]`
const PREFIX_MARKER = '(?:\\d+|[A-Za-z]+)[.)]'
const CODE_FIRST_ITEM = new RegExp(
  `^(?:[ \\t]*(?:>|[-+*](?=[ \\t])|${PREFIX_MARKER}(?=[ \\t])))*[ \\t]*${MARKER}[ \\t]+(?:\u0060{3,}|~{3,})`,
  'm'
)
const FENCE = /^[ ]{0,3}(?:`{3,}|~{3,})/
const PARSE_LIMIT = 50_000

function toMarkedToken(token: MarkdownToken): Tokens.Generic {
  return {
    ...token,
    type: token.type ?? '',
    raw: token.raw ?? '',
    tokens: token.tokens?.map(toMarkedToken),
    items: token.items?.map(toMarkedToken)
  }
}

export function hasUnsafeOrderedCodeFirstItem(content: string): boolean {
  if (!CODE_FIRST_ITEM.test(content)) {
    return false
  }
  // The rich parser drops first-block list fences; oversized candidates cannot be proved safe here.
  if (content.length > PARSE_LIMIT) {
    return true
  }
  try {
    const marked = createTiptapMarkedFacade()
    const containsCodeFirstItem = (): boolean => {
      let unsafe = false
      marked.walkTokens(marked.lexer(content), (token) => {
        if (token.type === 'list' && token.ordered) {
          unsafe ||= token.items.some((item) => {
            const first = item.tokens.find((child) => child.type !== 'space')
            return first && FENCE.test(first.raw) && marked.lexer(first.raw)[0]?.type === 'code'
          })
        }
      })
      return unsafe
    }
    if (containsCodeFirstItem()) {
      return true
    }
    // The editor also accepts alphabetic and Roman markers through its public tokenizer.
    const tokenizer = RichMarkdownOrderedList.config.markdownTokenizer
    if (!tokenizer || typeof tokenizer === 'function') {
      return true
    }
    marked.use({
      extensions: [
        {
          name: tokenizer.name,
          level: tokenizer.level ?? 'inline',
          start: typeof tokenizer.start === 'function' ? tokenizer.start : undefined,
          tokenizer(src, tokens) {
            const token = tokenizer.tokenize(src, tokens, {
              inlineTokens: (source) => this.lexer.inlineTokens(source),
              blockTokens: (source) => this.lexer.blockTokens(source)
            })
            return token ? toMarkedToken(token) : undefined
          }
        }
      ]
    })
    return containsCodeFirstItem()
  } catch {
    return true
  }
}
