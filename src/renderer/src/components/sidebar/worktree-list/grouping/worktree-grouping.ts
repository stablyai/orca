import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../../store/types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../../workspace-status'
import { PR_GROUP_META, PR_GROUP_ORDER, getPRGroupKey } from './group-keys'
import { addRepoIdToGroup, getProjectGroupingForRepo } from './project-grouping'
import type {
  OrderedGroupEntry,
  ProjectGroupingIndex,
  WorktreeGroupEntry
} from './project-grouping'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  WorktreeGroupBy
} from './row-types'
import { getManualOrderAnchorRepo, sortProjectEntries } from './section-order'

/** Buckets worktrees into their sections and returns them in render order. */
export function buildOrderedGroups(args: {
  groupBy: WorktreeGroupBy
  naturalWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
  settings: AppState['settings'] | undefined
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectIndex: ProjectGroupingIndex | null
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  repoOrder: Map<string, number> | undefined
  projectOrderBy: ProjectOrderBy
}): OrderedGroupEntry[] {
  const {
    groupBy,
    naturalWorktrees,
    repoMap,
    prCache,
    settings,
    workspaceStatuses,
    projectIndex,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy
  } = args

  const grouped = new Map<string, WorktreeGroupEntry>()
  for (const w of naturalWorktrees) {
    let key: string
    let label: string
    let repo: Repo | undefined
    if (groupBy === 'repo') {
      const grouping = getProjectGroupingForRepo(w.repoId, repoMap, projectIndex)
      key = grouping.key
      label = grouping.label
      repo = grouping.repo
    } else if (groupBy === 'workspace-status') {
      const workspaceStatus = getWorkspaceStatus(w, workspaceStatuses)
      key = getWorkspaceStatusGroupKey(workspaceStatus)
      label =
        workspaceStatuses.find((status) => status.id === workspaceStatus)?.label ?? workspaceStatus
    } else {
      const prGroup = getPRGroupKey(w, repoMap, prCache, settings)
      key = `pr:${prGroup}`
      label = PR_GROUP_META[prGroup].label
    }
    if (!grouped.has(key)) {
      grouped.set(key, { label, items: [], repo, repoIds: new Set() })
    }
    const group = grouped.get(key)!
    group.items.push(w)
    addRepoIdToGroup(group, w.repoId)
  }
  if (groupBy === 'repo') {
    for (const repoId of placeholderRepoIds) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      if (!grouping.repo) {
        continue
      }
      const key = grouping.key
      if (!grouped.has(key)) {
        // Why: repos can arrive before worktree scans, but stale IDs passed by
        // older snapshots must not render an "Unknown" project header.
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo,
          repoIds: new Set([repoId])
        })
      } else {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
  }
  if (groupBy === 'repo') {
    for (const [repoId, candidate] of importedWorktreesByRepo) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      const key = grouping.key
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo ?? candidate.repo,
          repoIds: new Set([repoId])
        })
      } else if (grouped.has(key)) {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
  }
  if (groupBy === 'repo') {
    for (const [repoId, candidate] of newExternalWorktreesInboxByRepo) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      const key = grouping.key
      if (!grouped.has(key)) {
        // Why: the default policy removes pinned worktrees from natural groups,
        // but actionable inbox rows still need a project section to render in.
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo ?? candidate.repo,
          repoIds: new Set([repoId])
        })
      } else if (grouped.has(key)) {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
  }
  if (groupBy === 'repo') {
    for (const repoId of pendingByRepo.keys()) {
      const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
      const key = grouping.key
      if (!grouped.has(key)) {
        // Why: creating the first worktree in a repo leaves it with no group yet;
        // ensure one so the in-progress row nests under its repo instead of being
        // dropped.
        grouped.set(key, {
          label: grouping.label,
          items: [],
          repo: grouping.repo,
          repoIds: new Set([repoId])
        })
      } else {
        addRepoIdToGroup(grouped.get(key)!, repoId)
      }
    }
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
    for (const group of grouped.values()) {
      // Why: logical project headers can contain multiple host setup repos.
      // Use the repo that anchors manual order so drag and actions target the
      // same persisted order source the row sorter reads.
      group.repo = getManualOrderAnchorRepo(group, repoMap, repoOrder)
    }
    // Why: project header order is its own user choice (projectOrderBy),
    // decoupled from workspace sortBy. Manual uses the canonical repoOrder so
    // header drag has a stable source of truth; Recent follows activity.
    const entries = sortProjectEntries(Array.from(grouped.entries()), projectOrderBy, repoOrder)
    // Why: large imported repo sets can have one group per repo; spreading
    // those entries into push can exceed V8's argument limit.
    for (const entry of entries) {
      orderedGroups.push(entry)
    }
  }
  return orderedGroups
}
