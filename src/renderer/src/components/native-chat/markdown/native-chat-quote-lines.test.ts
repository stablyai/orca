import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Root, RootContent } from 'mdast'
import { describe, expect, it } from 'vitest'
import { remarkNativeChatQuoteLines } from './native-chat-quote-lines'

/** Each line of the message: Q for a quote, the text, or EMPTY for an empty line. */
function lines(markdown: string): string[] {
  const processor = unified().use(remarkParse).use(remarkNativeChatQuoteLines)
  const tree = processor.runSync(processor.parse(markdown)) as Root
  const part = (node: RootContent): string =>
    node.type === 'blockquote' ? 'Q' : node.type === 'text' ? node.value : ''
  return tree.children.map((node) =>
    node.type === 'paragraph' && node.children[0]?.type === 'break'
      ? 'EMPTY'
      : node.type === 'paragraph'
        ? node.children.map(part).join(' ')
        : part(node)
  )
}

// The blank line after a quote belongs to the quote; other blank lines are lines the user typed.
describe('remarkNativeChatQuoteLines', () => {
  it.each([
    ['> q\n\nc', ['Q c']],
    ['> a\n\n> b\n\nc', ['Q Q c']],
    ['> q\n\n\nbelow', ['Q', 'below']],
    ['> q\n\n\n\nbelow', ['Q', 'EMPTY', 'below']],
    ['above\n\n> q\n\nc', ['above', 'EMPTY', 'Q c']]
  ])('reads %j as the lines %j', (markdown, expected) => {
    expect(lines(markdown)).toEqual(expected)
  })
})
