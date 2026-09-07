type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function collectText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const el = node as ReactElementLike
  return collectText(el.props?.children)
}

export function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

export function findDropdownMenuItemByText(node: unknown, text: string): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDropdownMenuItemByText(child, text)
      if (found) {
        return found
      }
    }
    return null
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return null
  }
  const el = node as ReactElementLike
  if (el.type === 'DropdownMenuItem' && collectText(el.props.children).includes(text)) {
    return el
  }
  return findDropdownMenuItemByText(el.props?.children, text)
}
