import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry, GitStagingArea } from '../../../../../../shared/git-status-types'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  type SourceControlTreeNode
} from '@/components/right-sidebar/source-control-tree'
import {
  getCombinedDiffFileTreeSectionKey,
  isGitStatusEntry,
  type CombinedDiffBranchTreeArea,
  type CombinedDiffFileTreeEntry,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'
import type { CombinedDiffTreeNode } from './combined-diff-file-tree-row'

const UNCOMMITTED_AREA_ORDER: readonly GitStagingArea[] = ['unstaged', 'staged', 'untracked']
const UNCOMMITTED_AREA_LABELS: Record<GitStagingArea, string> = {
  unstaged: 'Changes',
  staged: 'Staged Changes',
  untracked: 'Untracked Files'
}

export type CombinedDiffTreeGroup = {
  area: GitStagingArea
  label: string
  roots: CombinedDiffTreeNode[]
}

export type CombinedDiffTreeVisibility = {
  rows: CombinedDiffTreeNode[]
  visibleFileCount: number
  visibleFileCounts: ReadonlyMap<string, number>
}

export type { CombinedDiffTreeNode }

/** Build the uncommitted tree shape without volatile viewed/loading flags. */
export function buildCombinedDiffUncommittedTreeGroups(
  entries: readonly CombinedDiffFileTreeEntry[]
): CombinedDiffTreeGroup[] {
  return UNCOMMITTED_AREA_ORDER.map((area) => {
    const areaEntries = entries.filter(
      (entry): entry is GitStatusEntry => isGitStatusEntry(entry) && entry.area === area
    )
    if (areaEntries.length === 0) {
      return null
    }

    const roots = compactSourceControlTree(buildGitStatusSourceControlTree(area, areaEntries))
    return {
      area,
      label: UNCOMMITTED_AREA_LABELS[area],
      roots: roots as CombinedDiffTreeNode[]
    }
  }).filter((group): group is CombinedDiffTreeGroup => group !== null)
}

/** Build the committed tree shape without volatile viewed/loading flags. */
export function buildCombinedDiffBranchTreeRoots(
  mode: Extract<CombinedDiffFileTreeMode, 'all' | 'branch' | 'commit'>,
  entries: readonly CombinedDiffFileTreeEntry[]
): CombinedDiffTreeNode[] {
  const branchEntries = entries.filter(
    (entry): entry is GitBranchChangeEntry => !isGitStatusEntry(entry)
  )
  const area: CombinedDiffBranchTreeArea = mode === 'commit' ? 'combined-commit' : 'combined-branch'
  const roots = compactSourceControlTree(buildSourceControlTree(area, [...branchEntries]))
  return roots as CombinedDiffTreeNode[]
}

/** Flatten a stable tree shape; this is the path used when viewed files are included. */
export function flattenCombinedDiffTreeRoots(
  roots: readonly CombinedDiffTreeNode[],
  collapsedDirectoryKeys: ReadonlySet<string>
): CombinedDiffTreeNode[] {
  return flattenSourceControlTree(
    roots as SourceControlTreeNode<CombinedDiffFileTreeEntry, string>[],
    collapsedDirectoryKeys
  ) as CombinedDiffTreeNode[]
}

/**
 * Apply viewed state as a lightweight overlay. It filters and re-compacts the already-sorted tree
 * in linear time, preserving the file-tree shape while avoiding a fresh path build and sort.
 */
export function getViewedCombinedDiffTreeVisibility({
  roots,
  collapsedDirectoryKeys,
  mode,
  viewedSectionKeys
}: {
  roots: readonly CombinedDiffTreeNode[]
  collapsedDirectoryKeys: ReadonlySet<string>
  mode: CombinedDiffFileTreeMode
  viewedSectionKeys: ReadonlySet<string>
}): CombinedDiffTreeVisibility {
  const visibleFileCounts = new Map<string, number>()
  const rows: CombinedDiffTreeNode[] = []

  type VisibleTreeNode = {
    source: CombinedDiffTreeNode
    children: VisibleTreeNode[]
    fileCount: number
  }

  const projectVisibleTree = (node: CombinedDiffTreeNode): VisibleTreeNode | null => {
    if (node.type === 'file') {
      return viewedSectionKeys.has(getCombinedDiffFileTreeSectionKey(mode, node.entry))
        ? null
        : { source: node, children: [], fileCount: 1 }
    }
    const children = node.children
      .map((child) => projectVisibleTree(child as CombinedDiffTreeNode))
      .filter((child): child is VisibleTreeNode => child !== null)
    if (children.length === 0) {
      return null
    }
    return {
      source: node,
      children,
      fileCount: children.reduce((count, child) => count + child.fileCount, 0)
    }
  }

  const compactVisibleTree = (projected: VisibleTreeNode, depth: number): CombinedDiffTreeNode => {
    if (projected.source.type === 'file') {
      return { ...projected.source, depth }
    }
    const names = [projected.source.name]
    let compacted = projected
    // Keep a collapsed directory as a visible boundary; filtering must not compact it away and
    // accidentally expose descendants that the user explicitly hid.
    while (
      !collapsedDirectoryKeys.has(compacted.source.key) &&
      compacted.children.length === 1 &&
      compacted.children[0]?.source.type === 'directory'
    ) {
      compacted = compacted.children[0]
      names.push(compacted.source.name)
    }
    const compactedSource = compacted.source
    if (compactedSource.type !== 'directory') {
      throw new Error('Combined diff directory projection lost its source node')
    }
    const node = {
      ...compactedSource,
      name: names.join('/'),
      depth,
      fileCount: compacted.fileCount,
      children: compacted.children.map((child) => compactVisibleTree(child, depth + 1))
    } satisfies CombinedDiffTreeNode
    visibleFileCounts.set(node.key, node.fileCount)
    return node
  }

  const visit = (node: CombinedDiffTreeNode): void => {
    rows.push(node)
    if (node.type === 'directory' && !collapsedDirectoryKeys.has(node.key)) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }

  let visibleFileCount = 0
  for (const root of roots) {
    const projected = projectVisibleTree(root)
    if (!projected) {
      continue
    }
    const compacted = compactVisibleTree(projected, 0)
    visibleFileCount += projected.fileCount
    visit(compacted)
  }
  return { rows, visibleFileCount, visibleFileCounts }
}
