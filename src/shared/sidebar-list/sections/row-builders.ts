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
  const row: ImportedWorktreesCardRow = {
    type: 'imported-worktrees-card',
    key: `imported-worktrees-card:repo-group:${candidate.repo.id}`,
    repo: candidate.repo,
    hiddenWorktrees: candidate.hiddenWorktrees,
    placement: 'repo-group'
  }
  if (hostContext) {
    row.hostContextLabel = hostContext.label
    row.hostContextHostId = hostContext.hostId
  }
  return row
}

export function buildNewExternalWorktreesInboxRow(
  candidate: NewExternalWorktreesInboxCandidate,
  hostContext?: NoticeHostContext
): NewExternalWorktreesInboxRow {
  const row: NewExternalWorktreesInboxRow = {
    type: 'new-external-worktrees-inbox',
    key: `new-external-worktrees-inbox:${candidate.repo.id}`,
    repo: candidate.repo,
    inboxWorktrees: candidate.inboxWorktrees
  }
  if (hostContext) {
    row.hostContextLabel = hostContext.label
    row.hostContextHostId = hostContext.hostId
  }
  return row
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
  const sectionOccurrences = plan.bySection.get(options.sectionKey)
  if (!sectionOccurrences || sectionOccurrences.length === 0) {
    return
  }
  let childIdsByParent: Map<string, string[]> | undefined
  for (let i = 0; i < sectionOccurrences.length; i += 1) {
    const occurrence = sectionOccurrences[i]
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
  const lineageRanges = childIdsByParent ? buildWorktreeLineageRanges(plan) : undefined
  const occurrences =
    childIdsByParent && options.collapsedGroups.size > 0
      ? getExpandedWorktreeOccurrences(sectionOccurrences, (worktree) =>
          options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree))
        )
      : sectionOccurrences
  const folderPairByIdentity = options.folderPairByIdentity
  const hostContextLabelByWorktreeIdentity = options.hostContextLabelByWorktreeIdentity
  const hostContextLabelByRepoId = options.hostContextLabelByRepoId
  const hasFolderPairs = (folderPairByIdentity?.size ?? 0) > 0
  const hasWorktreeHostLabels = (hostContextLabelByWorktreeIdentity?.size ?? 0) > 0
  const hasRepoHostLabels = (hostContextLabelByRepoId?.size ?? 0) > 0
  const needsHostIdentity = hasFolderPairs || hasWorktreeHostLabels
  const groupDepth = options.groupDepth
  const collapsedGroups = options.collapsedGroups
  for (let i = 0; i < occurrences.length; i += 1) {
    const occurrence = occurrences[i]
    const worktree = occurrence.row
    const hostIdentity = needsHostIdentity ? getWorktreeHostIdentity(worktree) : undefined
    const folderPair = hasFolderPairs ? folderPairByIdentity!.get(hostIdentity!) : undefined
    const hasChildren = occurrence.childCount > 0
    if (folderPair) {
      result.push(
        buildFolderWorkspaceRow(folderPair, groupDepth, occurrence, {
          collapsedGroups,
          childWorktreeIds: hasChildren ? childIdsByParent?.get(occurrence.key) : undefined,
          descendantIdentities: hasChildren ? lineageRanges?.get(occurrence.key) : undefined,
          hostContextLabel: hasWorktreeHostLabels
            ? hostContextLabelByWorktreeIdentity!.get(hostIdentity!)
            : undefined
        })
      )
      continue
    }
    const hostContextLabel =
      (hasWorktreeHostLabels
        ? hostContextLabelByWorktreeIdentity!.get(hostIdentity!)
        : undefined) ??
      (hasRepoHostLabels ? hostContextLabelByRepoId!.get(worktree.repoId) : undefined)
    const lineageGroupKey = hasChildren ? getWorktreeLineageGroupKey(worktree) : undefined
    if (lineageGroupKey) {
      result.push({
        type: 'item',
        occurrence,
        rowKey: occurrence.key,
        sectionKey: occurrence.sectionKey,
        worktree,
        repo: repoOf(worktree),
        depth: occurrence.depth,
        groupDepth,
        isLastLineageChild: occurrence.isLastChild,
        lineageChildCount: occurrence.childCount,
        lineageChildWorktreeIds: childIdsByParent?.get(occurrence.key),
        lineageDescendantIdentities: lineageRanges?.get(occurrence.key),
        showProjectName: occurrence.showProjectName,
        hostContextLabel,
        lineageGroupKey,
        lineageCollapsed: collapsedGroups.has(lineageGroupKey)
      })
    } else {
      result.push({
        type: 'item',
        occurrence,
        rowKey: occurrence.key,
        sectionKey: occurrence.sectionKey,
        worktree,
        repo: repoOf(worktree),
        depth: occurrence.depth,
        groupDepth,
        isLastLineageChild: occurrence.isLastChild,
        lineageChildCount: occurrence.childCount,
        lineageChildWorktreeIds: undefined,
        lineageDescendantIdentities: undefined,
        showProjectName: occurrence.showProjectName,
        hostContextLabel
      })
    }
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
  const row: FolderWorkspaceRow = {
    type: 'folder-workspace',
    lineageDescendantIdentities: options?.descendantIdentities,
    key: `folder-workspace:${getFolderWorkspaceHostIdentity(pair.folderWorkspace)}`,
    folderWorkspace: pair.folderWorkspace,
    projectGroup: pair.projectGroup,
    depth: occurrence?.depth ?? 0,
    groupDepth
  }
  if (options?.hostContextLabel) {
    row.hostContextLabel = options.hostContextLabel
  }
  if (occurrence && occurrence.childCount > 0) {
    const lineageGroupKey = getWorktreeLineageGroupKey(occurrence.row)
    if (lineageGroupKey) {
      row.lineageChildCount = occurrence.childCount
      row.lineageChildWorktreeIds = options?.childWorktreeIds
      row.lineageGroupKey = lineageGroupKey
      row.lineageCollapsed = options?.collapsedGroups.has(lineageGroupKey) === true
    }
  }
  return row
}
