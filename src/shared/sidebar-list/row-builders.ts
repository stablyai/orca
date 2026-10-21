import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../folder-workspace-worktree'
import { getWorktreeLineageGroupKey } from './group-keys'
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
  Row
} from './row-types'

export function buildPendingCreationRow(
  creation: PendingCreationRef,
  repoMap: Map<string, Repo>
): PendingCreationRow {
  return {
    type: 'pending-creation',
    key: `pending:${creation.creationId}`,
    creationId: creation.creationId,
    repo: repoMap.get(creation.repoId)
  }
}

export function buildImportedWorktreesCardRow(
  candidate: ImportedWorktreesCardCandidate,
  placement: ImportedWorktreesCardRow['placement'],
  hostContext?: NoticeHostContext
): ImportedWorktreesCardRow {
  return {
    type: 'imported-worktrees-card',
    key: `imported-worktrees-card:${placement}:${candidate.repo.id}`,
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
    key: `new-external-worktrees-inbox:${candidate.repo.id}`,
    repo: candidate.repo,
    inboxWorktrees: candidate.inboxWorktrees,
    ...(hostContext
      ? { hostContextLabel: hostContext.label, hostContextHostId: hostContext.hostId }
      : {})
  }
}

export function appendWorktreeRows(
  result: Row[],
  repoMap: Map<string, Repo>,
  plan: WorktreeOccurrencePlan<Worktree>,
  options: {
    collapsedGroups: Set<string>
    groupDepth: number
    sectionKey: string
    hostContextLabelByRepoId?: ReadonlyMap<string, string>
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
      repo: repoMap.get(worktree.repoId),
      depth: occurrence.depth,
      groupDepth: options.groupDepth,
      isLastLineageChild: occurrence.isLastChild,
      lineageChildCount: occurrence.childCount,
      showProjectName: occurrence.showProjectName,
      hostContextLabel:
        options.hostContextLabelByWorktreeIdentity?.get(getWorktreeHostIdentity(worktree)) ??
        options.hostContextLabelByRepoId?.get(worktree.repoId),
      ...(occurrence.childCount > 0
        ? {
            lineageGroupKey: getWorktreeLineageGroupKey(worktree),
            lineageCollapsed: options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree))
          }
        : {})
    })
  }
}

/** The one folder-workspace row constructor, shared by the project-group,
 *  grouped-lane and flat emitters so their rows cannot diverge. Keyed by host: two hosts can
 *  share a folder id. */
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
