import type { MarkdownLexerConfiguration, MarkdownToken, MarkdownTokenizer } from '@tiptap/core'
import TaskList from '@tiptap/extension-task-list'

const baseTokenizer = TaskList.config.markdownTokenizer as MarkdownTokenizer

function normalizeTaskListToken(token: MarkdownToken, lexer: MarkdownLexerConfiguration): void {
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
