import { projectGroupIdFromRepoId } from '../folder-workspace-worktree'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import { getWorktreeLineageIdentity } from './worktree-lineage-projection'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../workspace-statuses'
import {
  compareFolderWorkspacesForDisplay,
  getFolderWorkspaceLaneKey,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import { PR_GROUP_ORDER, getPRLaneKey } from './group-keys'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import { buildProjectSections, type ProjectGroupingIndex } from '../project-section-grouping'
import { orderProjectSections } from '../project-section-order'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  SidebarPRGroupReader,
  WorktreeGroupBy
} from './row-types'

/** Buckets worktrees into their sections and returns them in render order. */
export function buildOrderedGroups(args: {
  groupBy: WorktreeGroupBy
  naturalWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prGroupOf: SidebarPRGroupReader
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectIndex: ProjectGroupingIndex | null
  displayRootByIdentity?: ReadonlyMap<string, Worktree>
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  repoOrder: Map<string, number> | undefined
  projectOrderBy: ProjectOrderBy
  folderWorkspaces?: readonly RenderableFolderWorkspace[]
}): OrderedGroupEntry[] {
  const {
    groupBy,
    naturalWorktrees,
    repoMap,
    prGroupOf,
    workspaceStatuses,
    projectIndex,
    displayRootByIdentity,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy,
    folderWorkspaces = []
  } = args

  if (groupBy === 'repo') {
    // Why shared: the paired phone builds its Project sections with this same function.
    const folderGroups = new Map<string, WorktreeGroupEntry>()
    const gitRows: Worktree[] = []
    for (const row of naturalWorktrees) {
      const root = displayRootByIdentity?.get(getWorktreeLineageIdentity(row)) ?? row
      if (projectGroupIdFromRepoId(root.repoId)) {
        const group = folderGroups.get(root.repoId) ?? {
          label: '',
          items: [],
          repoIds: new Set<string>()
        }
        group.items.push(row)
        folderGroups.set(root.repoId, group)
      } else {
        gitRows.push(row)
      }
    }
    return [
      ...buildProjectSections({
        items: gitRows,
        repoIdOf: (worktree) => worktree.repoId,
        displayRepoIdOf: (worktree) =>
          (displayRootByIdentity?.get(getWorktreeLineageIdentity(worktree)) ?? worktree).repoId,
        repoMap,
        projectIndex,
        placeholderRepoIds,
        noticeRepos: [
          ...[...importedWorktreesByRepo].map(
            ([repoId, candidate]) => [repoId, candidate.repo] as const
          ),
          ...[...newExternalWorktreesInboxByRepo].map(
            ([repoId, candidate]) => [repoId, candidate.repo] as const
          )
        ],
        pendingRepoIds: pendingByRepo.keys(),
        repoOrder,
        projectOrderBy
      }),
      ...folderGroups
    ]
  }

  // Why no lane labels: status and PR headers are named by the section emitter and the client.
  const grouped = new Map<string, WorktreeGroupEntry>()
  for (const w of naturalWorktrees) {
    const key =
      groupBy === 'workspace-status'
        ? getWorkspaceStatusGroupKey(getWorkspaceStatus(w, workspaceStatuses))
        : getPRLaneKey(prGroupOf(w))
    if (!grouped.has(key)) {
      grouped.set(key, { label: '', items: [], repo: undefined, repoIds: new Set() })
    }
    const group = grouped.get(key)!
    group.items.push(w)
    group.repoIds.add(w.repoId)
  }
  // Why: folder workspaces are not worktrees, so they never appear in the loop
  // above. Bucketing them here — and creating the lane when no worktree opened
  // one — is what lets a folder workspace be the sole occupant of a lane (#15362).
  for (const pair of folderWorkspaces) {
    const key = getFolderWorkspaceLaneKey(pair, groupBy, workspaceStatuses)
    if (!grouped.has(key)) {
      grouped.set(key, {
        label: '',
        items: [],
        repo: undefined,
        repoIds: new Set()
      })
    }
    const group = grouped.get(key)!
    group.folderWorkspaces ??= []
    group.folderWorkspaces.push(pair)
  }
  for (const group of grouped.values()) {
    group.folderWorkspaces?.sort((left, right) =>
      compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
    )
  }
  const orderedGroups: OrderedGroupEntry[] = []
  if (groupBy === 'pr-status') {
    for (const prGroup of PR_GROUP_ORDER) {
      const key = `pr:${prGroup}`
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else if (groupBy === 'workspace-status') {
    // Why: status grouping is opt-in while the board drawer remains the wider
    // all-lanes drag target; keep the sidebar compact by omitting empty lanes.
    for (const status of workspaceStatuses) {
      const key = getWorkspaceStatusGroupKey(status.id)
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else {
    const entries = orderProjectSections(grouped, repoMap, repoOrder, projectOrderBy)
    // Why: large imported repo sets can have one group per repo; spreading
    // those entries into push can exceed V8's argument limit.
    for (const entry of entries) {
      orderedGroups.push(entry)
    }
  }
  return orderedGroups
}
