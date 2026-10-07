import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type WorktreeLineageTreeNode = {
  worktree: Worktree
  repo?: Repo
  depth: number
  isRoot: boolean
  isTarget: boolean
  isNewlyLinked: boolean
  parentWorktreeId: string | null
  children: WorktreeLineageTreeNode[]
}

export type WorktreeLineageTreeGraph = {
  rootNode: WorktreeLineageTreeNode | null
  totalNodes: number
  targetNode: WorktreeLineageTreeNode | null
  newlyLinkedNode: WorktreeLineageTreeNode | null
}

export function findRootLineageAncestorId(
  startWorktreeId: string,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): string {
  let currentId = startWorktreeId
  const visited = new Set<string>()

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const parentId = lineageById[currentId]?.parentWorktreeId
    if (!parentId || !worktreeMap.has(parentId)) {
      break
    }
    currentId = parentId
  }

  return currentId
}

export function buildWorktreeLineageTreeGraph(args: {
  targetWorktreeId: string
  newlyLinkedId?: string
  lineageById: Readonly<Record<string, WorktreeLineage>>
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: ReadonlyMap<string, Repo>
}): WorktreeLineageTreeGraph {
  const { targetWorktreeId, newlyLinkedId, lineageById, worktreeMap, repoMap } = args
  const rootId = findRootLineageAncestorId(targetWorktreeId, lineageById, worktreeMap)
  const rootWorktree = worktreeMap.get(rootId)

  if (!rootWorktree) {
    return {
      rootNode: null,
      totalNodes: 0,
      targetNode: null,
      newlyLinkedNode: null
    }
  }

  // why: index children by parent to build the directed acyclic hierarchy tree
  const childrenByParent = new Map<string, string[]>()
  for (const [childId, lineage] of Object.entries(lineageById)) {
    if (lineage?.parentWorktreeId && worktreeMap.has(childId)) {
      const list = childrenByParent.get(lineage.parentWorktreeId) ?? []
      list.push(childId)
      childrenByParent.set(lineage.parentWorktreeId, list)
    }
  }

  let totalNodes = 0
  let targetNode: WorktreeLineageTreeNode | null = null
  let newlyLinkedNode: WorktreeLineageTreeNode | null = null
  const visited = new Set<string>()

  function buildNode(
    worktreeId: string,
    depth: number,
    parentId: string | null
  ): WorktreeLineageTreeNode | null {
    if (visited.has(worktreeId)) {
      return null
    }
    visited.add(worktreeId)

    const worktree = worktreeMap.get(worktreeId)
    if (!worktree) {
      return null
    }

    totalNodes += 1
    const childIds = childrenByParent.get(worktreeId) ?? []
    const children: WorktreeLineageTreeNode[] = []

    const node: WorktreeLineageTreeNode = {
      worktree,
      repo: repoMap.get(worktree.repoId),
      depth,
      isRoot: depth === 0,
      isTarget: worktreeId === targetWorktreeId,
      isNewlyLinked: worktreeId === newlyLinkedId,
      parentWorktreeId: parentId,
      children
    }

    if (node.isTarget) {
      targetNode = node
    }
    if (node.isNewlyLinked) {
      newlyLinkedNode = node
    }

    for (const childId of childIds) {
      const childNode = buildNode(childId, depth + 1, worktreeId)
      if (childNode) {
        children.push(childNode)
      }
    }

    return node
  }

  const rootNode = buildNode(rootId, 0, null)

  return {
    rootNode,
    totalNodes,
    targetNode,
    newlyLinkedNode
  }
}
