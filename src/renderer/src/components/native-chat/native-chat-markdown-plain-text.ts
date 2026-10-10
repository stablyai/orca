import type { List, Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse).use(remarkGfm)

export function nativeChatMarkdownPlainText(markdown: string): string {
  return nodeText(parser.parse(markdown)).trim()
}

function blocksText(nodes: readonly Nodes[], separator: string): string {
  return nodes.map(nodeText).filter(Boolean).join(separator)
}

function listText(list: List): string {
  return list.children
    .map((item, index) => {
      const marker = list.ordered ? `${(list.start ?? 1) + index}. ` : '- '
      const checkbox = typeof item.checked === 'boolean' ? (item.checked ? '[x] ' : '[ ] ') : ''
      const body = blocksText(item.children, item.spread ? '\n\n' : '\n')
      return marker + checkbox + body.replace(/\n(?=.)/g, `\n${' '.repeat(marker.length)}`)
    })
    .join(list.spread ? '\n\n' : '\n')
}

function nodeText(node: Nodes): string {
  if (node.type === 'html') {
    return node.value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  }
  if ('value' in node) {
    return node.value
  }
  if (node.type === 'break') {
    return '\n'
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    return node.alt ?? ''
  }
  if (node.type === 'link') {
    const label = blocksText(node.children, '')
    // GFM links a bare www. address as http://.
    const shown = node.url === label || node.url === `http://${label}`
    return /^https?:/i.test(node.url) && !shown ? `${label} (${node.url})` : label
  }
  if (node.type === 'list') {
    return listText(node)
  }
  if (node.type === 'table') {
    return node.children.map((row) => row.children.map(nodeText).join('\t')).join('\n')
  }
  if (node.type === 'root' || node.type === 'blockquote' || node.type === 'footnoteDefinition') {
    return blocksText(node.children, '\n\n')
  }
  return 'children' in node ? blocksText(node.children, '') : ''
}
