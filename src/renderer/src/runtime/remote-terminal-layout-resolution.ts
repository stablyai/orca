import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'

/**
 * Single source of truth for turning a set of terminal leaves into a layout
 * tree on the client. The host's published layout is authoritative; this module
 * exists so every client ingestion path resolves the tree the same way instead
 * of independently re-deriving it (which is how "Split Right" used to render as
 * a down split — divergent fallbacks each guessed a direction).
 *
 * Invariant: NEVER invent a split direction for a leaf some known tree already
 * places. A split's direction is meaningful user/host state, and the resolved
 * tree is persisted and pushed back to the host, so a guess that wins here
 * destroys the real direction on disk — a one-way door. A known tree that does
 * not match the leaf set exactly is still knowledge: it is pruned to the leaves
 * that survive and grafted with only the genuinely new ones, which is the sole
 * place a direction is invented (and always reported).
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
 * Drop every leaf outside `keep`; a split that loses one child collapses to the
 * other. Surviving splits keep the direction the user/host actually chose.
 */
export function pruneLayoutToLeaves(
  node: TerminalPaneLayoutNode | null | undefined,
  keep: ReadonlySet<string>
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return keep.has(node.leafId) ? node : null
  }
  const first = pruneLayoutToLeaves(node.first, keep)
  const second = pruneLayoutToLeaves(node.second, keep)
  if (first && second) {
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  return first ?? second
}

/**
 * Attach leaves no known tree describes. This is the only direction we invent,
 * so it is always reported; the retained subtree keeps its real directions.
 */
function graftUnplacedLeaves(
  root: TerminalPaneLayoutNode | null,
  unplacedLeafIds: readonly string[]
): TerminalPaneLayoutNode | null {
  return unplacedLeafIds.reduce<TerminalPaneLayoutNode | null>(
    (tree, leafId) =>
      tree === null
        ? { type: 'leaf', leafId }
        : { type: 'split', direction: 'horizontal', first: tree, second: { type: 'leaf', leafId } },
    root
  )
}

/** How many of `leafIds` this tree already places — its value as a donor. */
function countPlacedLeaves(
  root: TerminalPaneLayoutNode | null | undefined,
  leafIds: readonly string[]
): number {
  if (!root) {
    return 0
  }
  const treeLeafIds = collectLayoutLeafIds(root)
  return leafIds.filter((leafId) => treeLeafIds.has(leafId)).length
}

/**
 * Resolve the layout tree for `leafIds`, preferring authoritative/known trees
 * (which carry the real direction) over any invented structure.
 *
 * Precedence: a tree covering the leaves exactly (host-authoritative, then
 * prior client) → the tree placing the most leaves, pruned to them and grafted
 * with the rest → a degenerate chain when nothing is known.
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
  if (args.leafIds.length === 0) {
    return null
  }
  const authoritativePlaced = countPlacedLeaves(args.authoritativeRoot, args.leafIds)
  const existingPlaced = countPlacedLeaves(args.existingRoot, args.leafIds)
  // Ties go to the host tree; it is the authority for direction.
  const donor =
    authoritativePlaced === 0 && existingPlaced === 0
      ? null
      : authoritativePlaced >= existingPlaced
        ? args.authoritativeRoot
        : args.existingRoot
  const retained = pruneLayoutToLeaves(donor, new Set(args.leafIds))
  const placed = collectLayoutLeafIds(retained)
  const unplaced = args.leafIds.filter((leafId) => !placed.has(leafId))
  // One leaf and nothing retained is a bare leaf, which carries no direction.
  if (unplaced.length > (retained === null ? 1 : 0)) {
    args.onSynthesize?.(unplaced.length)
  }
  return graftUnplacedLeaves(retained, unplaced)
}
