import type { Repo } from '../repo-types'
import type { ProjectOrderBy, TagOrderBy } from '../ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../workspace-statuses'
import {
  compareFolderWorkspacesForDisplay,
  getFolderWorkspaceLaneKeys,
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
import { getTagSections, sortTagEntries, type TaggedSection } from './tag-groups'
import { preferTagSpelling } from '../worktree/worktree-tags'

function getFolderTagLaneLabel(key: string, pair: RenderableFolderWorkspace): string {
  return getTagSections(pair.folderWorkspace).find((section) => section.key === key)?.label ?? ''
}

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
  tagOrderBy?: TagOrderBy
  manualTagOrder?: readonly string[]
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
    tagOrderBy = 'name',
    manualTagOrder = [],
    folderWorkspaces = []
  } = args

  if (groupBy === 'repo') {
    // Why shared: the paired phone builds its Project sections with this same function.
    return buildProjectSections({
      items: naturalWorktrees,
      repoIdOf: (worktree) => worktree.repoId,
      displayRepoIdOf: (worktree) =>
        (displayRootByIdentity?.get(getWorktreeHostIdentity(worktree)) ?? worktree).repoId,
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
    })
  }

  // Why no status or PR lane labels: those headers are named by the section emitter and the client.
  const getSections = (w: Worktree): TaggedSection[] =>
    // Why: tag is the one mode where a workspace renders in several sections, once per tag.
    groupBy === 'tag'
      ? getTagSections(w)
      : [
          {
            key:
              groupBy === 'workspace-status'
                ? getWorkspaceStatusGroupKey(getWorkspaceStatus(w, workspaceStatuses))
                : getPRLaneKey(prGroupOf(w)),
            label: ''
          }
        ]

  const grouped = new Map<string, WorktreeGroupEntry>()
  for (const w of naturalWorktrees) {
    for (const { key, label } of getSections(w)) {
      if (!grouped.has(key)) {
        grouped.set(key, { label, items: [], repo: undefined, repoIds: new Set() })
      }
      const group = grouped.get(key)!
      if (groupBy === 'tag') {
        // Why: spellings of one tag differ per workspace; the header must not follow sort order.
        group.label = preferTagSpelling(group.label, label)
      }
      group.items.push(w)
      group.repoIds.add(w.repoId)
    }
  }
  // Why: folder workspaces are not worktrees, so they never appear in the loop
  // above. Bucketing them here — and creating the lane when no worktree opened
  // one — is what lets a folder workspace be the sole occupant of a lane (#15362).
  for (const pair of folderWorkspaces) {
    for (const key of getFolderWorkspaceLaneKeys(pair, groupBy, workspaceStatuses)) {
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: groupBy === 'tag' ? getFolderTagLaneLabel(key, pair) : '',
          items: [],
          repo: undefined,
          repoIds: new Set()
        })
      }
      const group = grouped.get(key)!
      if (groupBy === 'tag') {
        group.label = preferTagSpelling(group.label, getFolderTagLaneLabel(key, pair))
      }
      group.folderWorkspaces ??= []
      group.folderWorkspaces.push(pair)
    }
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
  } else if (groupBy === 'tag') {
    for (const entry of sortTagEntries(Array.from(grouped.entries()), tagOrderBy, manualTagOrder)) {
      orderedGroups.push(entry)
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
