import { extractTerminalHandleLinks } from '../../terminal-pane/links/handles/terminal-handle-links'

const TERMINAL_HREF_PREFIX = '#orca-terminal='

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

export function terminalHandleFromChatHref(href: string | undefined): string | null {
  if (!href?.startsWith(TERMINAL_HREF_PREFIX)) {
    return null
  }
  const handle = href.slice(TERMINAL_HREF_PREFIX.length)
  return extractTerminalHandleLinks(handle)[0]?.handle === handle ? handle : null
}

export function remarkNativeChatTerminalReferences() {
  return function linkTerminalReferences(node: MarkdownNode): void {
    if (node.type === 'link' || node.type === 'linkReference' || !node.children) {
      return
    }
    node.children = node.children.flatMap((child) => {
      if ((child.type !== 'text' && child.type !== 'inlineCode') || !child.value) {
        linkTerminalReferences(child)
        return [child]
      }
      const value = child.value
      const links = extractTerminalHandleLinks(value)
      if (!links.length || (child.type === 'inlineCode' && links[0].handle !== value)) {
        return [child]
      }
      const result: MarkdownNode[] = []
      let offset = 0
      for (const { handle, startIndex, endIndex } of links) {
        if (offset < startIndex) {
          result.push({ type: 'text', value: value.slice(offset, startIndex) })
        }
        result.push({
          type: 'link',
          url: TERMINAL_HREF_PREFIX + handle,
          children: [{ type: child.type, value: handle }]
        })
        offset = endIndex
      }
      if (offset < value.length) {
        result.push({ type: 'text', value: value.slice(offset) })
      }
      return result
    })
  }
}
