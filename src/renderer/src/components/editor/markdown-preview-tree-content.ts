import type { Nodes, RootContent } from 'hast'
import { MARKDOWN_PREVIEW_BLOCK_MAX_NODES } from './markdown-preview-document-types'

export function countMarkdownPreviewNodes(
  node: { children?: readonly unknown[] },
  limit: number
): number {
  let count = 0
  const pending: unknown[] = [node]
  while (pending.length > 0) {
    const current = pending.pop()
    count += 1
    if (count > limit) {
      return count
    }
    if (
      current &&
      typeof current === 'object' &&
      'children' in current &&
      Array.isArray(current.children)
    ) {
      for (const child of current.children) {
        pending.push(child)
      }
    }
  }
  return count
}

export function getMarkdownPreviewTreeText(node: Nodes, includeImageAlt = true): string {
  if (node.type === 'text') {
    return node.value
  }
  if (includeImageAlt && node.type === 'element' && node.tagName === 'img') {
    return String(node.properties.alt ?? '')
  }
  return 'children' in node
    ? node.children.map((child) => getMarkdownPreviewTreeText(child, includeImageAlt)).join('')
    : ''
}

export function isMarkdownPreviewBlockTooLarge(node: RootContent): boolean {
  return (
    countMarkdownPreviewNodes({ children: [node] }, MARKDOWN_PREVIEW_BLOCK_MAX_NODES) >
      MARKDOWN_PREVIEW_BLOCK_MAX_NODES || getMarkdownPreviewTreeText(node).length > 32_768
  )
}
