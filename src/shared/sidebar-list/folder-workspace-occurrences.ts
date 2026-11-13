import { getFolderWorkspaceWorktree } from '../folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { Worktree } from '../worktree/types'
import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'

const FOLDER_LANE_SECTION_PREFIX = 'folder-lane:'

/** A project group's folder workspaces and the rows nested under them, under that group's header. */
export function getFolderLaneSectionKey(projectGroupId: string): string {
  return `${FOLDER_LANE_SECTION_PREFIX}${projectGroupId}`
}

export function isFolderLaneSectionKey(key: string): boolean {
  return key.startsWith(FOLDER_LANE_SECTION_PREFIX)
}

/** Folder workspaces as occurrence rows: each keeps its own lane and order, and rows nested under one
 * follow it there. */
export function getSidebarFolderOccurrences(renderable: readonly RenderableFolderWorkspace[]) {
  const sorted = [...renderable].sort((left, right) =>
    compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
  )
  const rowOf = (pair: RenderableFolderWorkspace): Worktree =>
    getFolderWorkspaceWorktree(pair.folderWorkspace)
  const pairByIdentity = new Map<string, RenderableFolderWorkspace>()
  const groupIdByIdentity = new Map<string, string>()
  for (const pair of sorted) {
    const identity = getWorktreeHostIdentity(rowOf(pair))
    pairByIdentity.set(identity, pair)
    groupIdByIdentity.set(identity, pair.projectGroup.id)
  }
  const isFolder = (row: Worktree): boolean => pairByIdentity.has(getWorktreeHostIdentity(row))
  return {
    /** Every folder row, in display order. */
    rows: sorted.map(rowOf),
    pairByIdentity,
    isFolder,
    /** A lane's folder rows, already in display order. */
    rowsOf: (pairs: readonly RenderableFolderWorkspace[] | undefined): Worktree[] =>
      (pairs ?? []).map(rowOf),
    /** Project grouping: each group's folders, then the rows whose top shown ancestor is one of them,
     * and each such row's grouping root below the folder, so it still counts in its own project. */
    boundRowsByGroupId(
      natural: readonly Worktree[],
      displayRootByIdentity: ReadonlyMap<string, Worktree>,
      childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
    ) {
      const sectionItemsByGroupId = new Map<string, Worktree[]>()
      for (const pair of sorted) {
        const items = sectionItemsByGroupId.get(pair.projectGroup.id) ?? []
        items.push(rowOf(pair))
        sectionItemsByGroupId.set(pair.projectGroup.id, items)
      }
      const groupingRootByIdentity = new Map(displayRootByIdentity)
      const bound = new Set<Worktree>()
      for (const row of natural) {
        const root = displayRootByIdentity.get(getWorktreeHostIdentity(row))
        const groupId = root ? groupIdByIdentity.get(getWorktreeHostIdentity(root)) : undefined
        if (groupId === undefined || isFolder(row)) {
          continue
        }
        bound.add(row)
        sectionItemsByGroupId.get(groupId)?.push(row)
      }
      // A bound row groups by its top listed ancestor below the folder; hidden rows (archived, filtered)
      // pass through, so a row under one groups by its own repo, as it would without the folder.
      const listed = new Set(natural)
      const visited = new Set<string>()
      const pending: { row: Worktree; top?: Worktree }[] = [...pairByIdentity.keys()].flatMap(
        (folder) => (childrenByParentIdentity.get(folder) ?? []).map((row) => ({ row }))
      )
      for (let next = pending.pop(); next; next = pending.pop()) {
        const identity = getWorktreeHostIdentity(next.row)
        if (visited.has(identity)) {
          continue
        }
        visited.add(identity)
        const top = next.top ?? (listed.has(next.row) ? next.row : undefined)
        if (top && bound.has(next.row)) {
          groupingRootByIdentity.set(identity, top)
        }
        for (const child of childrenByParentIdentity.get(identity) ?? []) {
          pending.push({ row: child, top })
        }
      }
      return { bound, sectionItemsByGroupId, groupingRootByIdentity }
    }
  }
}

/** Project grouping: one natural section per project group's folders and their nested rows. */
export function getFolderLaneSections(
  folderBound: { sectionItemsByGroupId: ReadonlyMap<string, Worktree[]> } | null,
  projectGroupPaths: ReadonlyMap<string, OccurrenceSectionPath>
) {
  return [...(folderBound?.sectionItemsByGroupId ?? [])].map(([groupId, items]) => {
    const key = getFolderLaneSectionKey(groupId)
    return {
      key,
      group: { label: '', items: [], repoIds: new Set<string>() },
      placement: 'natural' as const,
      items,
      revealPath: { key, parent: projectGroupPaths.get(groupId) }
    }
  })
}
