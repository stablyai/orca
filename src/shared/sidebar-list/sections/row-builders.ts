import type { Repo } from '../../repository/repo-types'
import type { Worktree } from '../../worktree/types'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../../folder-workspaces/folder-workspace-worktree'
import { getWorktreeLineageGroupKey } from './group-keys'
import { buildWorktreeLineageRanges, type WorktreeLineageSource } from '../worktree-lineage-range'
import {
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrence,
  type WorktreeOccurrencePlan
} from '../lineage/worktree-occurrence-plan'
import type { NoticeHostContext } from '../hosts/host-labels'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
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
} from '../row-types'

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
  hostContext?: NoticeHostContext
): ImportedWorktreesCardRow {
  return {
    type: 'imported-worktrees-card',
    key: `imported-worktrees-card:repo-group:${candidate.repo.id}`,
    repo: candidate.repo,
    hiddenWorktrees: candidate.hiddenWorktrees,
    placement: 'repo-group',
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
  repoOf: RepoOfWorktree,
  plan: WorktreeOccurrencePlan<Worktree>,
  options: {
    collapsedGroups: Set<string>
    groupDepth: number
    sectionKey: string
    hostContextLabelByRepoId?: ReadonlyMap<string, string>
    hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>
    /** Occurrences that are folder workspaces render as folder rows. */
    folderPairByIdentity?: ReadonlyMap<string, RenderableFolderWorkspace>
  }
): void {
  const lineageRanges = buildWorktreeLineageRanges(plan)
  const sectionOccurrences = plan.bySection.get(options.sectionKey) ?? []
  let childIdsByParent: Map<string, string[]> | undefined
  for (const occurrence of sectionOccurrences) {
    if (occurrence.parent) {
      childIdsByParent ??= new Map<string, string[]>()
      const children = childIdsByParent.get(occurrence.parent.key)
      if (children) {
        children.push(occurrence.row.id)
      } else {
        childIdsByParent.set(occurrence.parent.key, [occurrence.row.id])
      }
    }
  }
  const occurrences =
    childIdsByParent && options.collapsedGroups.size > 0
      ? getExpandedWorktreeOccurrences(sectionOccurrences, (worktree) =>
          options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree))
        )
      : sectionOccurrences
  const needsHostIdentity = Boolean(
    options.folderPairByIdentity || options.hostContextLabelByWorktreeIdentity
  )
  for (const occurrence of occurrences) {
    const worktree = occurrence.row
    const hostIdentity = needsHostIdentity ? getWorktreeHostIdentity(worktree) : undefined
    const folderPair = hostIdentity ? options.folderPairByIdentity?.get(hostIdentity) : undefined
    if (folderPair) {
      result.push(
        buildFolderWorkspaceRow(folderPair, options.groupDepth, occurrence, {
          collapsedGroups: options.collapsedGroups,
          childWorktreeIds: childIdsByParent?.get(occurrence.key),
          descendantIdentities: lineageRanges.get(occurrence.key),
          hostContextLabel: hostIdentity
            ? options.hostContextLabelByWorktreeIdentity?.get(hostIdentity)
            : undefined
        })
      )
      continue
    }
    const lineageGroupKey =
      occurrence.childCount > 0 ? getWorktreeLineageGroupKey(worktree) : undefined
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
      lineageChildWorktreeIds: childIdsByParent?.get(occurrence.key),
      lineageDescendantIdentities: lineageRanges.get(occurrence.key),
      showProjectName: occurrence.showProjectName,
      hostContextLabel:
        (hostIdentity
          ? options.hostContextLabelByWorktreeIdentity?.get(hostIdentity)
          : undefined) ?? options.hostContextLabelByRepoId?.get(worktree.repoId),
      ...(lineageGroupKey
        ? {
            lineageGroupKey,
            lineageCollapsed: options.collapsedGroups.has(lineageGroupKey)
          }
        : {})
    })
  }
}

/** One host-keyed folder row constructor for all emitters; IDs can collide across hosts. */
export function buildFolderWorkspaceRow(
  pair: RenderableFolderWorkspace,
  groupDepth: number,
  occurrence?: WorktreeOccurrence<Worktree>,
  options?: {
    collapsedGroups: ReadonlySet<string>
    childWorktreeIds?: readonly string[]
    descendantIdentities?: WorktreeLineageSource
    hostContextLabel?: string
  }
): FolderWorkspaceRow {
  const lineageGroupKey =
    occurrence && occurrence.childCount > 0 ? getWorktreeLineageGroupKey(occurrence.row) : undefined
  return {
    type: 'folder-workspace',
    lineageDescendantIdentities: options?.descendantIdentities,
    key: `folder-workspace:${getFolderWorkspaceHostIdentity(pair.folderWorkspace)}`,
    folderWorkspace: pair.folderWorkspace,
    projectGroup: pair.projectGroup,
    depth: occurrence?.depth ?? 0,
    groupDepth,
    ...(options?.hostContextLabel ? { hostContextLabel: options.hostContextLabel } : {}),
    ...(occurrence && occurrence.childCount > 0 && lineageGroupKey
      ? {
          lineageChildCount: occurrence.childCount,
          lineageChildWorktreeIds: options?.childWorktreeIds,
          lineageGroupKey,
          lineageCollapsed: options?.collapsedGroups.has(lineageGroupKey) === true
        }
      : {})
  }
}
