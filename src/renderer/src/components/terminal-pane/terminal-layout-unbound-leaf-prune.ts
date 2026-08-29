import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import {
  collectLeafIdsInOrder,
  resolveTerminalLayoutActiveLeafId
} from './terminal-layout-leaf-ids'

/**
 * Drops layout leaves that have no PTY binding and no captured scrollback from
 * an in-session layout snapshot, collapsing their splits so the sibling
 * subtree takes the space.
 *
 * Why: a pane close (or a newborn-PTY failure) can tear down a leaf's PTY and
 * its `ptyIdsByLeafId` binding while a stale `root` still holds the leaf —
 * e.g. when the post-close layout persist loses to an unmount/park boundary.
 * Remounting such a snapshot materializes a pane for a terminal that no longer
 * exists, and a binding-less pane is unreachable by dead-session reconcile
 * (no PTY id to prove dead), so it stays blank forever.
 *
 * Pruning only applies when at least one leaf in the tree is still bound:
 * `ptyIdsByLeafId` is in-session state (dropped across app restart), so an
 * all-unbound tree is a restart restore — those leaves respawn or replay
 * scrollback and must be preserved. Callers must also skip host-authoritative
 * layouts (web client / remote-runtime tabs), where the host snapshot may
 * legitimately deliver leaves before their PTY ids.
 */
export function pruneUnboundTerminalLayoutLeaves(snapshot: TerminalLayoutSnapshot): {
  snapshot: TerminalLayoutSnapshot
  changed: boolean
} {
  const root = snapshot.root
  if (!root || root.type === 'leaf') {
    return { snapshot, changed: false }
  }
  const ptyIdsByLeafId = snapshot.ptyIdsByLeafId ?? {}
  const leafIds = collectLeafIdsInOrder(root)
  const hasBoundLeaf = leafIds.some((leafId) => ptyIdsByLeafId[leafId])
  if (!hasBoundLeaf) {
    return { snapshot, changed: false }
  }

  const isPrunable = (leafId: string): boolean =>
    !ptyIdsByLeafId[leafId] &&
    !snapshot.buffersByLeafId?.[leafId] &&
    !snapshot.scrollbackRefsByLeafId?.[leafId]

  const pruneNode = (node: TerminalPaneLayoutNode): TerminalPaneLayoutNode | null => {
    if (node.type === 'leaf') {
      return isPrunable(node.leafId) ? null : node
    }
    const first = pruneNode(node.first)
    const second = pruneNode(node.second)
    if (first && second) {
      return first === node.first && second === node.second ? node : { ...node, first, second }
    }
    return first ?? second
  }

  const prunedRoot = pruneNode(root)
  if (prunedRoot === root || prunedRoot === null) {
    return { snapshot, changed: false }
  }

  const remainingLeafIds = new Set(collectLeafIdsInOrder(prunedRoot))
  const filterToRemaining = (
    record: Record<string, string> | undefined
  ): Record<string, string> | undefined => {
    if (!record) {
      return undefined
    }
    const next = Object.fromEntries(
      Object.entries(record).filter(([leafId]) => remainingLeafIds.has(leafId))
    )
    return Object.keys(next).length > 0 ? next : undefined
  }

  const nextPtyIdsByLeafId = filterToRemaining(snapshot.ptyIdsByLeafId)
  const nextBuffersByLeafId = filterToRemaining(snapshot.buffersByLeafId)
  const nextScrollbackRefsByLeafId = filterToRemaining(snapshot.scrollbackRefsByLeafId)
  const nextTitlesByLeafId = filterToRemaining(snapshot.titlesByLeafId)
  const {
    ptyIdsByLeafId: _ptyIdsByLeafId,
    buffersByLeafId: _buffersByLeafId,
    scrollbackRefsByLeafId: _scrollbackRefsByLeafId,
    titlesByLeafId: _titlesByLeafId,
    ...snapshotWithoutLeafRecords
  } = snapshot
  return {
    snapshot: {
      ...snapshotWithoutLeafRecords,
      root: prunedRoot,
      activeLeafId: resolveTerminalLayoutActiveLeafId({
        root: prunedRoot,
        activeLeafId: snapshot.activeLeafId,
        ptyIdsByLeafId: nextPtyIdsByLeafId
      }),
      expandedLeafId:
        snapshot.expandedLeafId && remainingLeafIds.has(snapshot.expandedLeafId)
          ? snapshot.expandedLeafId
          : null,
      ...(nextPtyIdsByLeafId ? { ptyIdsByLeafId: nextPtyIdsByLeafId } : {}),
      ...(nextBuffersByLeafId ? { buffersByLeafId: nextBuffersByLeafId } : {}),
      ...(nextScrollbackRefsByLeafId ? { scrollbackRefsByLeafId: nextScrollbackRefsByLeafId } : {}),
      ...(nextTitlesByLeafId ? { titlesByLeafId: nextTitlesByLeafId } : {})
    },
    changed: true
  }
}
