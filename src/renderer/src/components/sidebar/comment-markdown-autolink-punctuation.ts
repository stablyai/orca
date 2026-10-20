import { trimUrlTrailingPunctuation } from '@/lib/url-trailing-punctuation'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

// GFM autolink literals render the URL as their own link text; an explicit
// `[label](url)` keeps the author's boundary and must never be re-trimmed.
function autolinkLiteralText(node: MarkdownNode): string | null {
  const child = node.children?.length === 1 ? node.children[0] : null
  const text = child?.type === 'text' ? child.value : undefined
  if (text === undefined || node.url === undefined) {
    return null
  }
  return node.url === text || node.url === `http://${text}` ? text : null
}

function splitTrailingPunctuation(node: MarkdownNode): MarkdownNode[] | null {
  const text = autolinkLiteralText(node)
  if (text === null || node.url === undefined) {
    return null
  }
  const trimmedUrl = trimUrlTrailingPunctuation(node.url)
  const removed = node.url.length - trimmedUrl.length
  if (removed === 0 || removed >= text.length) {
    return null
  }
  node.url = trimmedUrl
  node.children = [{ type: 'text', value: text.slice(0, -removed) }]
  return [node, { type: 'text', value: text.slice(-removed) }]
}

function transformAutolinkPunctuation(node: MarkdownNode): void {
  if (!node.children || node.type === 'image') {
    return
  }
  const children: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'link') {
      const split = splitTrailingPunctuation(child)
      children.push(...(split ?? [child]))
      continue
    }
    transformAutolinkPunctuation(child)
    children.push(child)
  }
  node.children = children
}

export function remarkAutolinkTrailingPunctuation(): (tree: MarkdownNode) => void {
  return (tree) => transformAutolinkPunctuation(tree)
}
