import type { TerminalPaneLayoutNode } from '../../../shared/types'

/**
 * Single source of truth for turning a set of terminal leaves into a layout
 * tree on the client. The host's published layout is authoritative; this module
 * exists so every client ingestion path resolves the tree the same way instead
 * of independently re-deriving it (which is how "Split Right" used to render as
 * a down split — divergent fallbacks each guessed a direction).
 *
 * Invariant: NEVER invent a split direction. A split's direction is meaningful
 * user/host state, so a guessed direction is wrong by construction. When no
 * authoritative tree covers the leaves, we keep whatever covering tree we do
 * have, and only as a true last resort synthesize a degenerate chain — logged
 * so the gap is visible rather than silently masquerading as a real layout.
 */

function collectLayoutLeafIds(
  node: TerminalPaneLayoutNode | null | undefined,
  leafIds = new Set<string>()
): Set<string> {
  if (!node) {
    return leafIds
  }
  if (node.type === 'leaf') {
    leafIds.add(node.leafId)
    return leafIds
  }
  collectLayoutLeafIds(node.first, leafIds)
  collectLayoutLeafIds(node.second, leafIds)
  return leafIds
}

/** Whether `root` is a layout for exactly `leafIds` — every leaf present, no extras. */
export function layoutCoversLeaves(
  root: TerminalPaneLayoutNode | null | undefined,
  leafIds: readonly string[]
): boolean {
  if (!root) {
    return false
  }
  const treeLeafIds = collectLayoutLeafIds(root)
  const known = new Set(leafIds)
  return (
    leafIds.every((leafId) => treeLeafIds.has(leafId)) &&
    [...treeLeafIds].every((leafId) => known.has(leafId))
  )
}

/**
 * Last-resort tree when no authoritative or prior layout covers the leaves.
 * A single leaf needs no direction; >1 leaf cannot be rendered as a split
 * without inventing one, so this path is degenerate and should not fire for a
 * real split — callers pass `onSynthesize` to surface when it does.
 */
function synthesizeDegenerateLayout(
  leafIds: readonly string[],
  onSynthesize?: (leafCount: number) => void
): TerminalPaneLayoutNode | null {
  if (leafIds.length === 0) {
    return null
  }
  if (leafIds.length === 1) {
    return { type: 'leaf', leafId: leafIds[0]! }
  }
  onSynthesize?.(leafIds.length)
  // No known direction: stack left-to-right as a flat chain. This is a visible
  // fallback, not a guess we want to win — see invariant above.
  return leafIds.slice(1).reduce<TerminalPaneLayoutNode>(
    (root, leafId) => ({
      type: 'split',
      direction: 'horizontal',
      first: root,
      second: { type: 'leaf', leafId }
    }),
    { type: 'leaf', leafId: leafIds[0]! }
  )
}

/**
 * Resolve the layout tree for `leafIds`, preferring authoritative/known trees
 * (which carry the real direction) over any synthesized fallback.
 *
 * Precedence: host-authoritative layout → prior client layout → degenerate.
 */
export function resolveTerminalLayoutRoot(args: {
  authoritativeRoot?: TerminalPaneLayoutNode | null
  existingRoot?: TerminalPaneLayoutNode | null
  leafIds: readonly string[]
  onSynthesize?: (leafCount: number) => void
}): TerminalPaneLayoutNode | null {
  if (layoutCoversLeaves(args.authoritativeRoot, args.leafIds)) {
    return args.authoritativeRoot ?? null
  }
  if (layoutCoversLeaves(args.existingRoot, args.leafIds)) {
    return args.existingRoot ?? null
  }
  return synthesizeDegenerateLayout(args.leafIds, args.onSynthesize)
}
