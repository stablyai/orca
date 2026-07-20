import type { PanelLayoutNode } from '../../../shared/types'

/** Runtime canvas tree: the persisted PanelLayout shape plus a stable `id` on
 *  every node. Leaf ids identify tiles — each tile owns its own PTY/webview —
 *  so they must survive re-renders and tree edits. */
export type PanelCanvasPanelLeaf = {
  id: string
  kind: 'terminal' | 'web'
  panelId: string
}

export type PanelCanvasShellLeaf = {
  id: string
  kind: 'shell'
  host: string | null
  label?: string
}

export type PanelCanvasLeaf = PanelCanvasPanelLeaf | PanelCanvasShellLeaf

export type PanelCanvasSplit = {
  id: string
  direction: 'row' | 'column'
  children: PanelCanvasNode[]
  sizes?: number[]
}

export type PanelCanvasNode = PanelCanvasLeaf | PanelCanvasSplit

export function isPanelCanvasLeaf(node: PanelCanvasNode): node is PanelCanvasLeaf {
  return 'kind' in node
}

function mintId(): string {
  return crypto.randomUUID()
}

export function canvasLeafFor(kind: 'terminal' | 'web', panelId: string): PanelCanvasLeaf {
  return { id: mintId(), kind, panelId }
}

export function canvasShellLeafFor(host: string | null, label?: string): PanelCanvasShellLeaf {
  return { id: mintId(), kind: 'shell', host, ...(label ? { label } : {}) }
}

/** A fresh tile showing the same thing as `leaf` — what a split produces. */
export function duplicateCanvasLeaf(leaf: PanelCanvasLeaf): PanelCanvasLeaf {
  return leaf.kind === 'shell'
    ? canvasShellLeafFor(leaf.host, leaf.label)
    : canvasLeafFor(leaf.kind, leaf.panelId)
}

/** Hydrates a persisted layout tree into a runtime canvas tree (fresh ids). */
export function canvasNodeFromLayout(node: PanelLayoutNode): PanelCanvasNode {
  if ('kind' in node) {
    return node.kind === 'shell'
      ? {
          id: mintId(),
          kind: 'shell',
          host: node.host,
          ...(node.label ? { label: node.label } : {})
        }
      : { id: mintId(), kind: node.kind, panelId: node.panelId }
  }
  return {
    id: mintId(),
    direction: node.direction,
    children: node.children.map(canvasNodeFromLayout),
    ...(node.sizes ? { sizes: [...node.sizes] } : {})
  }
}

/** Strips runtime ids back down to the persisted layout shape for saving. */
export function layoutNodeFromCanvas(node: PanelCanvasNode): PanelLayoutNode {
  if (isPanelCanvasLeaf(node)) {
    return node.kind === 'shell'
      ? { kind: 'shell', host: node.host, ...(node.label ? { label: node.label } : {}) }
      : { kind: node.kind, panelId: node.panelId }
  }
  return {
    direction: node.direction,
    children: node.children.map(layoutNodeFromCanvas),
    ...(node.sizes ? { sizes: [...node.sizes] } : {})
  }
}

export function countCanvasLeaves(node: PanelCanvasNode): number {
  if (isPanelCanvasLeaf(node)) {
    return 1
  }
  return node.children.reduce((total, child) => total + countCanvasLeaves(child), 0)
}

export function collectCanvasLeaves(node: PanelCanvasNode): PanelCanvasLeaf[] {
  if (isPanelCanvasLeaf(node)) {
    return [node]
  }
  return node.children.flatMap(collectCanvasLeaves)
}

/** Splits the tile `targetLeafId` in place: the leaf becomes a two-child split
 *  holding itself and `leaf`. When the leaf's parent already splits in the
 *  same direction, `leaf` is instead inserted as a sibling — so repeated
 *  "split right" grows one row instead of nesting a ladder. */
export function splitCanvasLeaf(
  root: PanelCanvasNode,
  targetLeafId: string,
  leaf: PanelCanvasLeaf,
  direction: 'row' | 'column'
): PanelCanvasNode {
  function visit(node: PanelCanvasNode): PanelCanvasNode {
    if (isPanelCanvasLeaf(node)) {
      if (node.id !== targetLeafId) {
        return node
      }
      return { id: mintId(), direction, children: [node, leaf] }
    }
    if (node.direction === direction) {
      const index = node.children.findIndex(
        (child) => isPanelCanvasLeaf(child) && child.id === targetLeafId
      )
      if (index !== -1) {
        const children = [...node.children]
        children.splice(index + 1, 0, leaf)
        // Why: the new sibling takes the split leaf's share; keeping stale
        // sizes would misalign weights with children.
        return { ...node, children, sizes: undefined }
      }
    }
    const children = node.children.map(visit)
    return children.some((child, index) => child !== node.children[index])
      ? { ...node, children }
      : node
  }
  return visit(root)
}

/** Appends a tile at the root level (used when no tile is targeted). */
export function appendCanvasLeaf(
  root: PanelCanvasNode,
  leaf: PanelCanvasLeaf,
  direction: 'row' | 'column'
): PanelCanvasNode {
  if (!isPanelCanvasLeaf(root) && root.direction === direction) {
    return { ...root, children: [...root.children, leaf], sizes: undefined }
  }
  return { id: mintId(), direction, children: [root, leaf] }
}

/** Removes a tile; single-child splits collapse into the child. Returns null
 *  when the last tile is removed. */
export function removeCanvasLeaf(root: PanelCanvasNode, leafId: string): PanelCanvasNode | null {
  function visit(node: PanelCanvasNode): PanelCanvasNode | null {
    if (isPanelCanvasLeaf(node)) {
      return node.id === leafId ? null : node
    }
    const children = node.children.map(visit).filter((child): child is PanelCanvasNode => {
      return child !== null
    })
    if (children.length === 0) {
      return null
    }
    if (children.length === 1) {
      return children[0]
    }
    if (children.length !== node.children.length) {
      return { ...node, children, sizes: undefined }
    }
    return children.some((child, index) => child !== node.children[index])
      ? { ...node, children }
      : node
  }
  return visit(root)
}

/** Writes the resized weights of one split node. */
export function setCanvasSplitSizes(
  root: PanelCanvasNode,
  splitId: string,
  sizes: number[]
): PanelCanvasNode {
  function visit(node: PanelCanvasNode): PanelCanvasNode {
    if (isPanelCanvasLeaf(node)) {
      return node
    }
    if (node.id === splitId) {
      return { ...node, sizes: [...sizes] }
    }
    const children = node.children.map(visit)
    return children.some((child, index) => child !== node.children[index])
      ? { ...node, children }
      : node
  }
  return visit(root)
}
