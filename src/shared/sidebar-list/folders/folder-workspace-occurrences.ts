import { getFolderWorkspaceWorktree } from '../../folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import { NO_HIDDEN_PROJECTS, type HiddenProjects } from '../../project/catalog/hidden-projects'
import type { Worktree } from '../../worktree/types'
import type { OccurrenceSectionPath } from '../lineage/worktree-occurrence-plan'
import { getVisibleLineagePlacement } from '../lineage/worktree-lineage-placement'
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

/** Each folder-bound row's grouping root: its top listed ancestor below the folder. Hidden rows
 * (archived, filtered) pass through, so a row under one groups by its own repo, as it would without
 * the folder. The paired phone binds its rows the same way. */
export function getFolderBoundGroupingRoots<Row>(args: {
  folderIdentities: Iterable<string>
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>
  identityOf: (row: Row) => string
  listed: ReadonlySet<Row>
  bound: ReadonlySet<Row>
}): Map<string, Row> {
  const roots = new Map<string, Row>()
  const visited = new Set<string>()
  const pending: { row: Row; top?: Row }[] = [...args.folderIdentities].flatMap((folder) =>
    (args.childrenByParentIdentity.get(folder) ?? []).map((row) => ({ row }))
  )
  for (let next = pending.pop(); next; next = pending.pop()) {
    const identity = args.identityOf(next.row)
    if (visited.has(identity)) {
      continue
    }
    visited.add(identity)
    const top = next.top ?? (args.listed.has(next.row) ? next.row : undefined)
    if (top && args.bound.has(next.row)) {
      roots.set(identity, top)
    }
    for (const child of args.childrenByParentIdentity.get(identity) ?? []) {
      pending.push({ row: child, top })
    }
  }
  return roots
}

/** A hidden project's row is placed only below a shown folder workspace, through shown rows (#43083). */
export function keepHiddenRowsBelowFolders<Row>(args: {
  rows: readonly Row[]
  folderRows: readonly Row[]
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>
  identityOf: (row: Row) => string
  isHidden: (row: Row) => boolean
}): Row[] {
  if (!args.rows.some(args.isHidden)) {
    return [...args.rows]
  }
  const below = getVisibleLineagePlacement(
    args.rows,
    args.folderRows,
    args.childrenByParentIdentity,
    args.identityOf
  )
  return args.rows.filter((row) => !args.isHidden(row) || below.has(args.identityOf(row)))
}

/** Folder workspaces as occurrence rows: each keeps its own lane and order, and rows nested under one
 * follow it there. */
export function getSidebarFolderOccurrences(
  renderable: readonly RenderableFolderWorkspace[],
  hiddenProjects: HiddenProjects = NO_HIDDEN_PROJECTS
) {
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
  const folderRows = sorted.map(rowOf)
  return {
    /** Every folder row, in display order. */
    rows: folderRows,
    pairByIdentity,
    isFolder,
    /** The row's project is hidden, so it shows only in a folder's lane. */
    isHiddenRow: hiddenProjects.isRowHidden,
    /** The rows the plan places, then every folder row. */
    withPlacedRows: (
      worktrees: readonly Worktree[],
      childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
    ): Worktree[] =>
      keepHiddenRowsBelowFolders({
        rows: [...worktrees, ...folderRows],
        folderRows,
        childrenByParentIdentity,
        identityOf: getWorktreeHostIdentity,
        isHidden: hiddenProjects.isRowHidden
      }),
    /** The rows that count in their own projects. Under project grouping a hidden project's rows
     * never do: they show only in their folder's lane (#43083). */
    projectRows: (rows: readonly Worktree[], projectGrouping: boolean): Worktree[] =>
      rows.filter((row) => !isFolder(row) && !(projectGrouping && hiddenProjects.isRowHidden(row))),
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
      const roots = getFolderBoundGroupingRoots({
        folderIdentities: pairByIdentity.keys(),
        childrenByParentIdentity,
        identityOf: getWorktreeHostIdentity,
        // A hidden row never roots a shown row's project (#43083).
        listed: new Set(natural.filter((row) => !hiddenProjects.isRowHidden(row))),
        bound
      })
      for (const [identity, top] of roots) {
        groupingRootByIdentity.set(identity, top)
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
