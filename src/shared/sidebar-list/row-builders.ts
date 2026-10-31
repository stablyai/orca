import type { ExecutionHostId } from '../execution-host'
import { ALL_GROUP_KEY, getWorktreeLineageGroupKey } from './group-keys'
import { getLaneHostWorktreeCounts, getLaneHostWorktreeIds } from './host-labels'
import { compareFolderWorkspacesForDisplay } from './folder-workspace-lanes'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../execution-host'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../folder-workspace-worktree'
import {
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrencePlan
} from '../worktree-occurrence-plan'
import type { NoticeHostContext } from './host-labels'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import type {
  FolderWorkspaceRow,
  ImportedWorktreesCardCandidate,
  ImportedWorktreesCardRow,
  NewExternalWorktreesInboxCandidate,
  NewExternalWorktreesInboxRow,
  PendingCreationRef,
  PendingCreationRow,
  RepoOfWorktree,
  Row
} from './row-types'

export function buildPendingCreationRow(
  creation: PendingCreationRef,
  repoMap: Map<string, Repo>,
  repoByHost?: ReadonlyMap<string, Repo>
): PendingCreationRow {
  return {
    type: 'pending-creation',
    key: `pending:${creation.creationId}`,
    creationId: creation.creationId,
    repo: creation.hostId
      ? (repoByHost?.get(`${creation.hostId}\0${creation.repoId}`) ??
        (getRepoExecutionHostId(repoMap.get(creation.repoId) ?? {}) === creation.hostId
          ? repoMap.get(creation.repoId)
          : undefined))
      : repoMap.get(creation.repoId)
  }
}

export function buildImportedWorktreesCardRow(
  candidate: ImportedWorktreesCardCandidate,
  placement: ImportedWorktreesCardRow['placement'],
  hostContext?: NoticeHostContext
): ImportedWorktreesCardRow {
  return {
    type: 'imported-worktrees-card',
    key: `imported-worktrees-card:${placement}:${composeWorktreeHostIdentity(getRepoExecutionHostId(candidate.repo), candidate.repo.id)}`,
    repo: candidate.repo,
    hiddenWorktrees: candidate.hiddenWorktrees,
    placement,
    ...(hostContext
      ? { hostContextLabel: hostContext.label, hostContextHostId: hostContext.hostId }
      : {})
  }
}

export function buildNewExternalWorktreesInboxRow(
  candidate: NewExternalWorktreesInboxCandidate,
  hostContext?: NoticeHostContext
): NewExternalWorktreesInboxRow {
  return {
    type: 'new-external-worktrees-inbox',
    key: `new-external-worktrees-inbox:${composeWorktreeHostIdentity(getRepoExecutionHostId(candidate.repo), candidate.repo.id)}`,
    repo: candidate.repo,
    inboxWorktrees: candidate.inboxWorktrees,
    ...(hostContext
      ? { hostContextLabel: hostContext.label, hostContextHostId: hostContext.hostId }
      : {})
  }
}

export function appendWorktreeRows(
  result: Row[],
  repoOf: RepoOfWorktree,
  plan: WorktreeOccurrencePlan<Worktree>,
  options: {
    collapsedGroups: Set<string>
    groupDepth: number
    sectionKey: string
    hostContextLabelByHostId?: ReadonlyMap<ExecutionHostId, string>
    defaultHostId?: ExecutionHostId
    hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>
  }
): void {
  const occurrences = getExpandedWorktreeOccurrences(
    plan.bySection.get(options.sectionKey) ?? [],
    (worktree) => options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree))
  )
  for (const occurrence of occurrences) {
    const worktree = occurrence.row
    result.push({
      type: 'item',
      occurrence,
      rowKey: occurrence.key,
      sectionKey: occurrence.sectionKey,
      worktree,
      repo: repoOf(worktree),
      depth: occurrence.depth,
      groupDepth: options.groupDepth,
      isLastLineageChild: occurrence.isLastChild,
      lineageChildCount: occurrence.childCount,
      showProjectName: occurrence.showProjectName,
      hostContextLabel:
        options.hostContextLabelByWorktreeIdentity?.get(getWorktreeHostIdentity(worktree)) ??
        options.hostContextLabelByHostId?.get(
          getWorktreeExecutionHostId(worktree, repoOf(worktree), options.defaultHostId ?? 'local')
        ),
      ...(occurrence.childCount > 0
        ? {
            lineageGroupKey: getWorktreeLineageGroupKey(worktree),
            lineageCollapsed: options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree))
          }
        : {})
    })
  }
}

/** One host-keyed folder row constructor for all emitters; IDs can collide across hosts. */
export function buildFolderWorkspaceRow(
  pair: RenderableFolderWorkspace,
  groupDepth: number
): FolderWorkspaceRow {
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${getFolderWorkspaceHostIdentity(pair.folderWorkspace)}`,
    folderWorkspace: pair.folderWorkspace,
    projectGroup: pair.projectGroup,
    depth: 0,
    groupDepth
  }
}

export function appendUngroupedWorkspaceRows({
  naturalWorktrees,
  renderableFolderWorkspaces,
  repoOf,
  defaultHostId,
  collapsedGroups,
  occurrencePlan,
  mixedWorktreeHostContextLabels,
  result
}: {
  naturalWorktrees: readonly Worktree[]
  renderableFolderWorkspaces: readonly RenderableFolderWorkspace[]
  repoOf: RepoOfWorktree
  defaultHostId: ExecutionHostId
  collapsedGroups: Set<string>
  occurrencePlan: WorktreeOccurrencePlan<Worktree>
  mixedWorktreeHostContextLabels?: ReadonlyMap<string, string>
  result: Row[]
}): void {
  // Folder-only accounts must still render flat rows (#15362).
  if (naturalWorktrees.length > 0 || renderableFolderWorkspaces.length > 0) {
    result.push({
      type: 'header',
      key: ALL_GROUP_KEY,
      count: naturalWorktrees.length + renderableFolderWorkspaces.length,
      icon: { kind: 'all' },
      hostWorktreeCounts: getLaneHostWorktreeCounts(
        naturalWorktrees,
        renderableFolderWorkspaces,
        repoOf,
        defaultHostId
      ),
      hostWorktreeIds: getLaneHostWorktreeIds(
        naturalWorktrees,
        renderableFolderWorkspaces,
        repoOf,
        defaultHostId
      ),
      worktreeIds: naturalWorktrees.map((worktree) => worktree.id)
    })
    if (!collapsedGroups.has(ALL_GROUP_KEY)) {
      appendWorktreeRows(result, repoOf, occurrencePlan, {
        collapsedGroups,
        groupDepth: 0,
        sectionKey: ALL_GROUP_KEY,
        hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels
      })
      for (const pair of [...renderableFolderWorkspaces].sort((left, right) =>
        compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
      )) {
        result.push(buildFolderWorkspaceRow(pair, 0))
      }
    }
  }
}
