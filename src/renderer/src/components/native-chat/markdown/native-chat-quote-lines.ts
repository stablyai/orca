import type { Paragraph, PhrasingContent, Root, RootContent } from 'mdast'

// A quote renders as a chip, which is inline content.
const inline = (quote: RootContent) => quote as unknown as PhrasingContent

const blankLinesBetween = (previous: RootContent, node: RootContent): number =>
  (node.position?.start.line ?? 0) - (previous.position?.end.line ?? 0) - 1

/**
 * Shows the lines of a message as the composer shows them. The blank line after a quote belongs
 * to the quote: a quote or a paragraph right after it goes on the quote's line. A quote line comes
 * right after the line above it: the blank line between text and a quote shows no empty line.
 * Each other blank line next to a quote is an empty line the user typed.
 */
export function remarkNativeChatQuoteLines() {
  return (tree: Root): void => {
    const children: RootContent[] = []
    tree.children.forEach((node, index) => {
      const previous = tree.children[index - 1]
      const blank = previous ? blankLinesBetween(previous, node) : 0
      if (
        previous?.type === 'blockquote' &&
        blank === 1 &&
        (node.type === 'paragraph' || node.type === 'blockquote')
      ) {
        ;(children.at(-1) as Paragraph).children.push(
          { type: 'text', value: ' ' },
          ...(node.type === 'paragraph' ? node.children : [inline(node)])
        )
        return
      }
      const typed =
        previous?.type === 'blockquote' ? blank - 2 : node.type === 'blockquote' ? blank - 1 : 0
      for (let line = 0; line < typed; line++) {
        children.push({ type: 'paragraph', children: [{ type: 'break' }] })
      }
      if (node.type !== 'blockquote') {
        children.push(node)
        return
      }
      // A div, not a p: HTML closes a p at the blockquote of the quote.
      children.push({
        type: 'paragraph',
        data: { hName: 'div', hProperties: { dataNativeChatQuoteLine: '' } },
        children: [inline(node)]
      })
    })
    tree.children = children
  }
}
