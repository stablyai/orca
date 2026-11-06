import type { Repo } from '../../repo-types'
import type { Worktree } from '../../worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../../folder-workspaces/folder-workspace-worktree'
import { getWorktreeLineageGroupKey } from './group-keys'
import {
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrence,
  type WorktreeOccurrencePlan
} from '../../worktree-occurrence-plan'
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

/** Pre-order occurrences: a parent's descendants are the run after it that is deeper. */
function descendantIdentities(
  occurrences: readonly WorktreeOccurrence<Worktree>[],
  start: number
): HostScopedWorktreeKey[] {
  const parentDepth = occurrences[start]!.depth
  const identities: HostScopedWorktreeKey[] = []
  for (let index = start + 1; index < occurrences.length; index++) {
    const occurrence = occurrences[index]!
    if (occurrence.depth <= parentDepth) {
      break
    }
    identities.push(getWorktreeHostIdentity(occurrence.row))
  }
  return identities
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
  const sectionOccurrences = plan.bySection.get(options.sectionKey) ?? []
  const childIdsByParent = new Map<string, string[]>()
  const childIdentitiesByParent = new Map<string, HostScopedWorktreeKey[]>()
  const indexByKey = new Map<string, number>()
  sectionOccurrences.forEach((occurrence, index) => {
    indexByKey.set(occurrence.key, index)
    if (occurrence.parent) {
      const children = childIdsByParent.get(occurrence.parent.key) ?? []
      children.push(occurrence.row.id)
      childIdsByParent.set(occurrence.parent.key, children)
      const identities = childIdentitiesByParent.get(occurrence.parent.key) ?? []
      identities.push(getWorktreeHostIdentity(occurrence.row))
      childIdentitiesByParent.set(occurrence.parent.key, identities)
    }
  })
  const occurrences = getExpandedWorktreeOccurrences(sectionOccurrences, (worktree) =>
    options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree))
  )
  for (const occurrence of occurrences) {
    const worktree = occurrence.row
    const folderPair = options.folderPairByIdentity?.get(getWorktreeHostIdentity(worktree))
    if (folderPair) {
      result.push(
        buildFolderWorkspaceRow(folderPair, options.groupDepth, occurrence, {
          collapsedGroups: options.collapsedGroups,
          childWorktreeIds: childIdsByParent.get(occurrence.key),
          hostContextLabel: options.hostContextLabelByWorktreeIdentity?.get(
            getWorktreeHostIdentity(worktree)
          )
        })
      )
      continue
    }
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
      lineageChildWorktreeIds: childIdsByParent.get(occurrence.key),
      lineageChildIdentities: childIdentitiesByParent.get(occurrence.key),
      showProjectName: occurrence.showProjectName,
      hostContextLabel:
        options.hostContextLabelByWorktreeIdentity?.get(getWorktreeHostIdentity(worktree)) ??
        options.hostContextLabelByRepoId?.get(worktree.repoId),
      ...(occurrence.childCount > 0
        ? {
            lineageGroupKey: getWorktreeLineageGroupKey(worktree),
            lineageCollapsed: options.collapsedGroups.has(getWorktreeLineageGroupKey(worktree)),
            lineageDescendantIdentities: descendantIdentities(
              sectionOccurrences,
              indexByKey.get(occurrence.key)!
            )
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
    hostContextLabel?: string
  }
): FolderWorkspaceRow {
  const lineageGroupKey =
    occurrence && occurrence.childCount > 0 ? getWorktreeLineageGroupKey(occurrence.row) : undefined
  return {
    type: 'folder-workspace',
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
