import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/workspace-layout/terminal-tab-types'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { collectLayoutGroupIds } from '@/runtime/web-session-tabs-sync/tab-group-layout-tree'

type Branch<Leaf extends { type: 'leaf' }> = {
  type: 'split'
  direction: 'horizontal' | 'vertical'
  ratio?: number
  first: Tree<Leaf>
  second: Tree<Leaf>
}
type Tree<Leaf extends { type: 'leaf' }> = Leaf | Branch<Leaf>

function ids<Leaf extends { type: 'leaf' }>(
  node: Tree<Leaf> | null,
  identity: (leaf: Leaf) => string
): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [identity(node)]
    : [...ids(node.first, identity), ...ids(node.second, identity)]
}

function prune<Leaf extends { type: 'leaf' }>(
  node: Tree<Leaf>,
  keep: ReadonlySet<string>,
  identity: (leaf: Leaf) => string
): Tree<Leaf> | null {
  if (node.type === 'leaf') {
    return keep.has(identity(node)) ? node : null
  }
  const first = prune(node.first, keep, identity)
  const second = prune(node.second, keep, identity)
  return first && second ? { ...node, first, second } : (first ?? second)
}

function replace<Leaf extends { type: 'leaf' }>(
  node: Tree<Leaf>,
  target: Tree<Leaf>,
  replacement: Tree<Leaf>
): Tree<Leaf> {
  if (node === target) {
    return replacement
  }
  if (node.type === 'leaf') {
    return node
  }
  const first = replace(node.first, target, replacement)
  const second = replace(node.second, target, replacement)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Insert only the addressed addition at its proved sibling, keeping the current sibling intact. */
function addAddressedNode<Leaf extends { type: 'leaf' }>(
  current: Tree<Leaf> | null,
  described: Tree<Leaf> | null,
  addedId: string,
  identity: (leaf: Leaf) => string
): Tree<Leaf> | null {
  if (!described || !ids(described, identity).includes(addedId)) {
    return null
  }
  if (!current) {
    return prune(described, new Set([addedId]), identity)
  }
  const currentIds = new Set(ids(current, identity))
  const describedIds = new Set(ids(described, identity))
  if (currentIds.has(addedId)) {
    return current
  }
  const path: { branch: Branch<Leaf>; addedFirst: boolean }[] = []
  const find = (node: Tree<Leaf>): boolean => {
    if (node.type === 'leaf') {
      return identity(node) === addedId
    }
    if (find(node.first)) {
      path.push({ branch: node, addedFirst: true })
      return true
    }
    if (find(node.second)) {
      path.push({ branch: node, addedFirst: false })
      return true
    }
    return false
  }
  find(described)
  for (const { branch, addedFirst } of path) {
    const sibling = addedFirst ? branch.second : branch.first
    const anchorIds = ids(sibling, identity).filter((id) => currentIds.has(id))
    if (anchorIds.length === 0) {
      continue
    }
    const wanted = new Set(anchorIds)
    const anchor: { node?: Tree<Leaf> } = {}
    const findAnchor = (node: Tree<Leaf>): { foreign: number; matching: number } => {
      const counts =
        node.type === 'leaf'
          ? {
              foreign: describedIds.has(identity(node)) && !wanted.has(identity(node)) ? 1 : 0,
              matching: wanted.has(identity(node)) ? 1 : 0
            }
          : (() => {
              const first = findAnchor(node.first)
              const second = findAnchor(node.second)
              return {
                foreign: first.foreign + second.foreign,
                matching: first.matching + second.matching
              }
            })()
      if (!anchor.node && counts.foreign === 0 && counts.matching === wanted.size) {
        anchor.node = node
      }
      return counts
    }
    findAnchor(current)
    if (!anchor.node) {
      return null
    }
    const addition = prune(addedFirst ? branch.first : branch.second, new Set([addedId]), identity)!
    return replace(current, anchor.node, {
      ...branch,
      first: addedFirst ? addition : anchor.node,
      second: addedFirst ? anchor.node : addition
    })
  }
  return null
}

export function mergeRetainedPaneLayout(
  current: TerminalLayoutSnapshot | undefined,
  described: TerminalLayoutSnapshot,
  leafId: string
): TerminalLayoutSnapshot | null {
  const root = addAddressedNode(
    current?.root ?? null,
    described.root,
    leafId,
    (leaf: Extract<TerminalPaneLayoutNode, { type: 'leaf' }>) => leaf.leafId
  )
  if (!root) {
    return null
  }
  if (current && root === current.root) {
    return current
  }
  const currentIds = new Set(collectLeafIds(current?.root))
  const added = new Set(collectLeafIds(root).filter((id) => !currentIds.has(id)))
  const mergeRecord = <T>(
    before: Record<string, T> | undefined,
    incoming: Record<string, T> | undefined
  ): Record<string, T> | undefined => {
    const entries = Object.entries(incoming ?? {}).filter(([id]) => added.has(id))
    return entries.length ? { ...Object.fromEntries(entries), ...before } : before
  }
  return {
    ...(current ?? described),
    root,
    activeLeafId: current ? current.activeLeafId : leafId,
    expandedLeafId: current
      ? current.expandedLeafId
      : described.expandedLeafId === leafId
        ? leafId
        : null,
    chatLeafId: current ? current.chatLeafId : described.chatLeafId === leafId ? leafId : undefined,
    ptyIdsByLeafId: mergeRecord(current?.ptyIdsByLeafId, described.ptyIdsByLeafId),
    buffersByLeafId: mergeRecord(current?.buffersByLeafId, described.buffersByLeafId),
    scrollbackRefsByLeafId: mergeRecord(
      current?.scrollbackRefsByLeafId,
      described.scrollbackRefsByLeafId
    ),
    titlesByLeafId: mergeRecord(current?.titlesByLeafId, described.titlesByLeafId),
    lastGridsByLeafId: mergeRecord(current?.lastGridsByLeafId, described.lastGridsByLeafId)
  }
}

export function mergeRetainedGroupLayout(
  current: TabGroupLayoutNode | null | undefined,
  described: TabGroupLayoutNode | undefined,
  groupId: string
): TabGroupLayoutNode | null {
  if (collectLayoutGroupIds(current ?? undefined).has(groupId)) {
    return current!
  }
  return addAddressedNode(
    current ?? null,
    described ?? { type: 'leaf', groupId },
    groupId,
    (leaf: Extract<TabGroupLayoutNode, { type: 'leaf' }>) => leaf.groupId
  )
}
