export type TerminalPaneLayoutNodeInput =
  | { type: 'leaf'; leafId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: TerminalPaneLayoutNodeInput
      second: TerminalPaneLayoutNodeInput
      ratio?: number
    }

// Cap depth/node count iteratively before building: recursive parsing of untrusted layout trees can overflow main’s stack.
export const MAX_PANE_LAYOUT_DEPTH = 64

export const MAX_PANE_LAYOUT_NODES = 1024

export function parseTerminalPaneLayoutNode(value: unknown): TerminalPaneLayoutNodeInput | null {
  let nodeCount = 0
  const stack: { raw: unknown; depth: number }[] = [{ raw: value, depth: 0 }]
  while (stack.length > 0) {
    const { raw, depth } = stack.pop()!
    if (depth > MAX_PANE_LAYOUT_DEPTH || ++nodeCount > MAX_PANE_LAYOUT_NODES) {
      return null
    }
    if (typeof raw !== 'object' || raw === null) {
      return null
    }
    const node = raw as Record<string, unknown>
    if (node.type === 'leaf') {
      if (typeof node.leafId !== 'string' || node.leafId.length < 1 || node.leafId.length > 128) {
        return null
      }
      continue
    }
    if (node.type === 'split') {
      if (node.direction !== 'horizontal' && node.direction !== 'vertical') {
        return null
      }
      if (
        node.ratio !== undefined &&
        (typeof node.ratio !== 'number' ||
          !Number.isFinite(node.ratio) ||
          node.ratio < 0 ||
          node.ratio > 1)
      ) {
        return null
      }
      stack.push({ raw: node.first, depth: depth + 1 }, { raw: node.second, depth: depth + 1 })
      continue
    }
    return null
  }
  return value as TerminalPaneLayoutNodeInput
}
