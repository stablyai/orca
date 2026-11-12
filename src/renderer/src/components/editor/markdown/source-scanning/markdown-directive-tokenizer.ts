import type { NodeConfig } from '@tiptap/core'
import { createMarkdownTokenizerStart } from './markdown-tokenizer-start'

export function guardMarkdownDirectiveTokenizer(
  tokenizer: NodeConfig['markdownTokenizer'],
  name: string
): NodeConfig['markdownTokenizer'] {
  if (!tokenizer || typeof tokenizer === 'function') {
    return tokenizer
  }
  const marker = `:::${name}`
  return {
    ...tokenizer,
    start: createMarkdownTokenizerStart(marker, true),
    tokenize(source, tokens, lexer) {
      return source.startsWith(marker) ? tokenizer.tokenize(source, tokens, lexer) : undefined
    }
  }
}
