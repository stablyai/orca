import type { MarkdownLexerConfiguration, MarkdownToken, MarkdownTokenizer } from '@tiptap/core'
import { TaskList } from '@tiptap/extension-list'

const baseTokenizer = TaskList.config.markdownTokenizer as MarkdownTokenizer

function inlineTokenSpansLineBreak(tokens: MarkdownToken[], lineBreak: number): boolean {
  let offset = 0
  for (const token of tokens) {
    if (typeof token.raw !== 'string') {
      return false
    }
    const end = offset + token.raw.length
    if (offset <= lineBreak && end > lineBreak) {
      return token.type !== 'text'
    }
    offset = end
  }
  return false
}

function normalizeTaskListToken(token: MarkdownToken, lexer: MarkdownLexerConfiguration): void {
  if (token.type === 'taskItem') {
    for (const nested of token.nestedTokens ?? []) {
      if (
        nested.type === 'paragraph' &&
        typeof nested.text === 'string' &&
        /^[ \t]/m.test(nested.text)
      ) {
        // Why: Tiptap dedents task children by two columns, leaving deeper paragraph indent as text.
        nested.text = nested.text.replace(/^[ \t]+/gm, '')
        nested.raw = nested.text
        nested.tokens = lexer.inlineTokens(nested.text)
      }
    }
  }
  const firstNested = token.nestedTokens?.[0]
  if (
    token.type === 'taskItem' &&
    firstNested?.type === 'code' &&
    firstNested.codeBlockStyle === 'indented' &&
    typeof firstNested.text === 'string'
  ) {
    // Tiptap re-lexes aligned no-blank task continuations as indented code.
    firstNested.type = 'paragraph'
    firstNested.raw = firstNested.text
    firstNested.tokens = lexer.inlineTokens(firstNested.text)
    delete firstNested.codeBlockStyle
  }

  if (
    token.type === 'taskItem' &&
    (firstNested?.type === 'paragraph' || firstNested?.type === 'text') &&
    typeof token.text === 'string' &&
    typeof firstNested.text === 'string'
  ) {
    const text = `${token.text}\n${firstNested.text}`
    const inlineTokens = lexer.inlineTokens(text)
    if (inlineTokenSpansLineBreak(inlineTokens, token.text.length)) {
      token.text = text
      token.tokens = inlineTokens
      token.nestedTokens.shift()
    }
  }

  if (token.type === 'taskItem') {
    for (const nested of token.nestedTokens ?? []) {
      if (nested.type === 'text') {
        nested.type = 'paragraph'
      }
    }
  }

  for (const child of [...(token.items ?? []), ...(token.nestedTokens ?? [])]) {
    normalizeTaskListToken(child, lexer)
  }
}

export const RichMarkdownTaskList = TaskList.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (typeof baseTokenizer.start === 'function' && baseTokenizer.start(src) !== 0) {
        return undefined
      }
      const token = baseTokenizer.tokenize(src, tokens, lexer)
      if (token) {
        normalizeTaskListToken(token, lexer)
      }
      return token
    }
  }
})
