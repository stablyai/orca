import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'

/** Same shape as RemoteTerminalTarget; named for the split-tree domain. */
export type PeersPaneLeaf = RemoteTerminalTarget

export type PeersSplitDirection = 'row' | 'column'

export type PeersLayoutNode =
  | { type: 'leaf'; target: PeersPaneLeaf }
  | {
      type: 'split'
      direction: PeersSplitDirection
      first: PeersLayoutNode
      second: PeersLayoutNode
      /** Flex ratio of the first child (0-1). Defaults to 0.5 if absent. */
      ratio?: number
    }

export type PeersSplitSide = 'left' | 'right' | 'top' | 'bottom'

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

export function leafKey(target: Pick<PeersPaneLeaf, 'hostId' | 'handle'>): string {
  return `${target.hostId}:${target.handle}`
}

export function collectLeaves(node: PeersLayoutNode): PeersPaneLeaf[] {
  if (node.type === 'leaf') {
    return [node.target]
  }
  return [...collectLeaves(node.first), ...collectLeaves(node.second)]
}

/** Removes the leaf matching `targetKey`, promoting its sibling; returns null if the whole tree was that leaf. */
export function removeLeaf(node: PeersLayoutNode, targetKey: string): PeersLayoutNode | null {
  if (node.type === 'leaf') {
    return leafKey(node.target) === targetKey ? null : node
  }
  if (node.first.type === 'leaf' && leafKey(node.first.target) === targetKey) {
    return node.second
  }
  if (node.second.type === 'leaf' && leafKey(node.second.target) === targetKey) {
    return node.first
  }
  const first = removeLeaf(node.first, targetKey)
  const second = removeLeaf(node.second, targetKey)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  return { ...node, first, second }
}

function replaceLeafWithSplit(
  node: PeersLayoutNode,
  atLeafKey: string,
  side: PeersSplitSide,
  newTarget: PeersPaneLeaf
): PeersLayoutNode {
  if (node.type === 'leaf') {
    if (leafKey(node.target) !== atLeafKey) {
      return node
    }
    const direction: PeersSplitDirection = side === 'left' || side === 'right' ? 'row' : 'column'
    const newLeaf: PeersLayoutNode = { type: 'leaf', target: newTarget }
    return side === 'left' || side === 'top'
      ? { type: 'split', direction, first: newLeaf, second: node }
      : { type: 'split', direction, first: node, second: newLeaf }
  }
  const first = replaceLeafWithSplit(node.first, atLeafKey, side, newTarget)
  const second = replaceLeafWithSplit(node.second, atLeafKey, side, newTarget)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Replaces the leaf at `atLeafKey` with a split holding it and `newTarget`. If `newTarget` is already in the tree, it's moved (removed first) rather than duplicated. */
export function insertSplit(
  node: PeersLayoutNode,
  atLeafKey: string,
  side: PeersSplitSide,
  newTarget: PeersPaneLeaf
): PeersLayoutNode {
  const newKey = leafKey(newTarget)
  if (newKey === atLeafKey) {
    return node
  }
  const alreadyPresent = collectLeaves(node).some((leaf) => leafKey(leaf) === newKey)
  const workingNode = alreadyPresent ? (removeLeaf(node, newKey) ?? node) : node
  return replaceLeafWithSplit(workingNode, atLeafKey, side, newTarget)
}

export function clampPeersSplitRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

export type PeersLayoutPathSegment = 'first' | 'second'

export function setRatioAtPath(
  node: PeersLayoutNode,
  path: readonly PeersLayoutPathSegment[],
  ratio: number
): PeersLayoutNode {
  const clamped = clampPeersSplitRatio(ratio)
  if (path.length === 0) {
    return node.type === 'split' ? { ...node, ratio: clamped } : node
  }
  if (node.type !== 'split') {
    return node
  }
  const [segment, ...rest] = path
  return segment === 'first'
    ? { ...node, first: setRatioAtPath(node.first, rest, ratio) }
    : { ...node, second: setRatioAtPath(node.second, rest, ratio) }
}

/** Replaces the target of every leaf whose current key is a key in `replacements` — one pass, so swapping two leaves' targets is safe (each match is against the node's own pre-swap key). */
export function replaceLeafTargets(
  node: PeersLayoutNode,
  replacements: ReadonlyMap<string, PeersPaneLeaf>
): PeersLayoutNode {
  if (node.type === 'leaf') {
    const replacement = replacements.get(leafKey(node.target))
    return replacement ? { ...node, target: replacement } : node
  }
  const first = replaceLeafTargets(node.first, replacements)
  const second = replaceLeafTargets(node.second, replacements)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Removes leaves that fail `isAlive`, promoting survivors; returns null if none survive. */
export function pruneLeaves(
  node: PeersLayoutNode,
  isAlive: (target: PeersPaneLeaf) => boolean
): PeersLayoutNode | null {
  if (node.type === 'leaf') {
    return isAlive(node.target) ? node : null
  }
  const first = pruneLeaves(node.first, isAlive)
  const second = pruneLeaves(node.second, isAlive)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
