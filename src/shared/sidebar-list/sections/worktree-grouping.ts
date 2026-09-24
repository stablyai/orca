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
  getFolderWorkspaceLaneKeys,
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
import { compareTagSections, getTagSections, type TaggedSection } from './tag-groups'
import { preferTagSpelling } from '../../worktree/metadata/worktree-tags'

function getFolderTagLaneLabel(key: string, pair: RenderableFolderWorkspace): string {
  return getTagSections(pair.folderWorkspace).find((section) => section.key === key)?.label ?? ''
}

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
    // Shared with paired-phone Project sections.
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

  // Section emitters/clients supply status and PR labels; tag mode renders a workspace once per tag.
  const getSections = (w: Worktree): TaggedSection[] =>
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
  // Folder workspaces bypass the worktree loop; create their lanes even when they are the only occupants (#15362).
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
    const entries = Array.from(grouped.entries()).sort(([leftKey, left], [rightKey, right]) =>
      compareTagSections({ key: leftKey, label: left.label }, { key: rightKey, label: right.label })
    )
    for (const entry of entries) {
      orderedGroups.push(entry)
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
