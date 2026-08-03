import { extractFilePathProseSpans } from '@/lib/file-path-prose-spans'

// Linkify bare file paths in prose by emitting standard mdast `link` nodes.
//
// Why `link` and not a custom node: CommentMarkdown sanitizes after remark
// (rehypeSanitize with the default schema), which drops unknown tags and
// data-attributes. `<a href>` is the only shape that survives, and it lands on
// the anchor renderer that already routes through onLinkClick.

type MarkdownTextNode = {
  type: 'text'
  value: string
}

type MarkdownLinkNode = {
  type: 'link'
  url: string
  title: null
  children: MarkdownTextNode[]
}

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

function createFilePathLinkNode(label: string): MarkdownLinkNode {
  const url = /^[A-Za-z]:[\\/]/.test(label) ? label.replace(':', '%3A') : label
  return {
    type: 'link',
    url,
    title: null,
    children: [{ type: 'text', value: label }]
  }
}

function splitFilePathText(value: string): MarkdownNode[] {
  const spans = extractFilePathProseSpans(value)
  if (spans.length === 0) {
    return [{ type: 'text', value }]
  }

  const parts: MarkdownNode[] = []
  let cursor = 0
  for (const span of spans) {
    // The detector can emit overlapping candidates; a linear reassembly must
    // take the first and skip anything already consumed.
    if (span.startIndex < cursor) {
      continue
    }
    if (span.startIndex > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, span.startIndex) })
    }
    // The raw slice keeps any :line:col suffix, which the click path parses.
    parts.push(createFilePathLinkNode(value.slice(span.startIndex, span.endIndex)))
    cursor = span.endIndex
  }

  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

function transformFilePathChildren(node: MarkdownNode): void {
  // Existing links keep their href; code spans are handled by the code renderer.
  if (
    !node.children ||
    node.type === 'link' ||
    node.type === 'linkReference' ||
    node.type === 'image'
  ) {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      for (const part of splitFilePathText(child.value)) {
        nextChildren.push(part)
      }
    } else {
      transformFilePathChildren(child)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}

export function remarkFilePathLinks(): () => (tree: MarkdownNode) => void {
  return () => (tree) => transformFilePathChildren(tree)
}
