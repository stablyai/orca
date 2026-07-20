import type { PanelLayout, PanelLayoutNode } from './types'

// Why: a layout references already-capped pinned panels; these bounds only
// guard against a corrupted profile smuggling unbounded trees into every
// settings broadcast.
export const MAX_PANEL_LAYOUTS = 16
export const MAX_PANEL_LAYOUT_LEAVES = 12
const MAX_PANEL_LAYOUT_DEPTH = 5
const MAX_LAYOUT_TITLE_LENGTH = 60

function normalizeLayoutNode(
  value: unknown,
  depth: number,
  budget: { leaves: number }
): PanelLayoutNode | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const node = value as Record<string, unknown>
  if (node.kind === 'terminal' || node.kind === 'web') {
    if (typeof node.panelId !== 'string' || node.panelId.length === 0) {
      return null
    }
    if (budget.leaves <= 0) {
      return null
    }
    budget.leaves -= 1
    return { kind: node.kind, panelId: node.panelId }
  }
  if (node.kind === 'shell') {
    // Why: host is a target id/label resolved at spawn time (null = local);
    // an empty string would silently mean "local", so reject it outright.
    if (node.host !== null && (typeof node.host !== 'string' || node.host.length === 0)) {
      return null
    }
    if (budget.leaves <= 0) {
      return null
    }
    budget.leaves -= 1
    const label =
      typeof node.label === 'string' && node.label.trim().length > 0
        ? node.label.trim().slice(0, MAX_LAYOUT_TITLE_LENGTH)
        : undefined
    return { kind: 'shell', host: node.host, ...(label ? { label } : {}) }
  }
  if (node.direction !== 'row' && node.direction !== 'column') {
    return null
  }
  if (depth >= MAX_PANEL_LAYOUT_DEPTH || !Array.isArray(node.children)) {
    return null
  }
  const children = node.children
    .map((child) => normalizeLayoutNode(child, depth + 1, budget))
    .filter((child): child is PanelLayoutNode => child !== null)
  if (children.length === 0) {
    return null
  }
  if (children.length === 1) {
    // Why: single-child splits render identically to the child but survive
    // forever in the profile; collapse them at the write boundary.
    return children[0]
  }
  const sizes =
    Array.isArray(node.sizes) &&
    node.sizes.length === children.length &&
    node.sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0)
      ? (node.sizes as number[])
      : undefined
  return { direction: node.direction, children, ...(sizes ? { sizes } : {}) }
}

/** Drops malformed entries instead of failing the whole settings write, so one
 *  bad layout (hand-edited profile, older build) can't wedge the rest. */
export function normalizePanelLayouts(value: unknown): PanelLayout[] {
  if (!Array.isArray(value)) {
    return []
  }
  const layouts: PanelLayout[] = []
  const seenIds = new Set<string>()
  for (const entry of value) {
    if (layouts.length >= MAX_PANEL_LAYOUTS) {
      break
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      continue
    }
    if (seenIds.has(candidate.id)) {
      continue
    }
    if (typeof candidate.title !== 'string') {
      continue
    }
    const title = candidate.title.trim().slice(0, MAX_LAYOUT_TITLE_LENGTH)
    if (title.length === 0) {
      continue
    }
    const root = normalizeLayoutNode(candidate.root, 0, { leaves: MAX_PANEL_LAYOUT_LEAVES })
    if (root === null) {
      continue
    }
    seenIds.add(candidate.id)
    layouts.push({ id: candidate.id, title, root })
  }
  return layouts
}

export function countPanelLayoutLeaves(node: PanelLayoutNode): number {
  if ('kind' in node) {
    return 1
  }
  return node.children.reduce((total, child) => total + countPanelLayoutLeaves(child), 0)
}
