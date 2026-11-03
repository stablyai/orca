import type { Nodes, Root } from 'mdast'

type ParseWork = {
  discovery: string[]
  render: string[]
  shifts: number
  cloneNodes: number
  cloneBytes: number
  scans: { source: string; marker: string }[]
  blocks: number
}

export function createParseWork(): ParseWork {
  return {
    discovery: [],
    render: [],
    shifts: 0,
    cloneNodes: 0,
    cloneBytes: 0,
    scans: [],
    blocks: 0
  }
}

export function nodeCount(node: Nodes): number {
  return 1 + ('children' in node ? node.children.reduce((n, child) => n + nodeCount(child), 0) : 0)
}

// Meter actual coordinate writes, leaving the parser's values and clone semantics unchanged.
export function meterPositions(tree: Root, onWrite: () => void): void {
  function visit(node: Nodes): void {
    if (node.position) {
      for (const point of [node.position.start, node.position.end]) {
        let offset = point.offset
        Object.defineProperty(point, 'offset', {
          enumerable: true,
          configurable: true,
          get: () => offset,
          set: (value: number) => {
            onWrite()
            offset = value
          }
        })
      }
    }
    if ('children' in node) {
      node.children.forEach(visit)
    }
  }
  visit(tree)
}
