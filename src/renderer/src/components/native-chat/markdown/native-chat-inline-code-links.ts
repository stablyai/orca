import type { Element, Root } from 'hast'
import { isInlineCodeHttpUrl } from '../../../../../shared/markdown/inline-code-http-url'

function linkInlineCode(parent: Root | Element): void {
  parent.children.forEach((child, index) => {
    if (child.type !== 'element' || child.tagName === 'a' || child.tagName === 'pre') {
      return
    }
    if (child.tagName !== 'code') {
      linkInlineCode(child)
      return
    }
    const [label] = child.children
    if (child.children.length === 1 && label?.type === 'text' && isInlineCodeHttpUrl(label.value)) {
      parent.children[index] = {
        type: 'element',
        tagName: 'a',
        properties: { href: label.value },
        children: [child],
        position: child.position
      }
    }
  })
}

// Raw HTML and Markdown links are both anchors by this point, so their labels keep their destinations.
export function rehypeNativeChatInlineCodeLinks(): (tree: Root) => void {
  return linkInlineCode
}
