import type { Repo } from '../../repository/repo-types'
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../worktree/types'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import {
  getWorkspaceStatus,
  getWorkspaceStatusGroupKey
} from '../../workspace/status/workspace-statuses'
import {
  compareFolderWorkspacesForDisplay,
  getFolderWorkspaceLaneKey,
  type RenderableFolderWorkspace
} from '../folders/folder-workspace-lanes'
import './group-keys'
import { PR_GROUP_ORDER, getPRLaneKey } from '../../workspace-view/workspace-pr-groups'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import { buildProjectSections, type ProjectGroupingIndex } from './project-section-grouping'
import { orderProjectSections } from './project-section-order'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  SidebarPRGroupReader,
  WorktreeGroupBy
} from '../row-types'

const EMPTY_NOTICE_REPOS: readonly (readonly [string, Repo])[] = []

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
    let noticeRepos: readonly (readonly [string, Repo])[] = EMPTY_NOTICE_REPOS
    if (importedWorktreesByRepo.size > 0 || newExternalWorktreesInboxByRepo.size > 0) {
      const pairs: (readonly [string, Repo])[] = []
      for (const [repoId, candidate] of importedWorktreesByRepo) {
        pairs.push([repoId, candidate.repo])
      }
      for (const [repoId, candidate] of newExternalWorktreesInboxByRepo) {
        pairs.push([repoId, candidate.repo])
      }
      noticeRepos = pairs
    }
    // Shared with paired-phone Project sections.
    return buildProjectSections({
      items: naturalWorktrees,
      repoIdOf: (worktree) => worktree.repoId,
      displayRepoIdOf: (worktree) =>
        (displayRootByIdentity?.get(getWorktreeHostIdentity(worktree)) ?? worktree).repoId,
      repoMap,
      projectIndex,
      placeholderRepoIds,
      noticeRepos,
      pendingRepoIds: pendingByRepo.keys(),
      repoOrder,
      projectOrderBy
    })
  }

  // Section emitters/clients supply status and PR labels.
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
  // Folder workspaces bypass the worktree loop; create their lanes even when they are the only occupants (#15362).
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
    // Status grouping is opt-in; omit empty sidebar lanes while the board keeps all drag targets.
    for (const status of workspaceStatuses) {
      const key = getWorkspaceStatusGroupKey(status.id)
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else {
    const entries = orderProjectSections(grouped, repoMap, repoOrder, projectOrderBy)
    // Imported repo counts can exceed V8’s argument limit for push(...entries).
    for (const entry of entries) {
      orderedGroups.push(entry)
    }
  }
  return orderedGroups
}
