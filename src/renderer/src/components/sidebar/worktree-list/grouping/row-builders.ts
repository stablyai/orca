import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isValidResolvedWorktreeLineageEdge } from '../../../../../../shared/resolved-worktree-lineage'
import { getProjectedWorktreeLineage } from '../../worktree-lineage-projection'
import { getWorktreeLineageGroupKey } from './group-keys'
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
  Row,
  WorktreeRow
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

function buildWorktreeRow(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  options: {
    rowKey: string
    sectionKey: string
    depth: number
    groupDepth: number
    lineageTrail: boolean[]
    isLastLineageChild: boolean
    lineageChildCount: number
    lineageCollapsed: boolean
    hostContextLabel?: string
  }
): WorktreeRow {
  return {
    type: 'item',
    rowKey: options.rowKey,
    sectionKey: options.sectionKey,
    worktree,
    repo: repoMap.get(worktree.repoId),
    depth: options.depth,
    groupDepth: options.groupDepth,
    lineageTrail: options.lineageTrail,
    isLastLineageChild: options.isLastLineageChild,
    lineageChildCount: options.lineageChildCount,
    ...(options.hostContextLabel ? { hostContextLabel: options.hostContextLabel } : {}),
    ...(options.lineageChildCount > 0
      ? { lineageGroupKey: getWorktreeLineageGroupKey(worktree) }
      : {}),
    ...(options.lineageChildCount > 0 ? { lineageCollapsed: options.lineageCollapsed } : {})
  }
}

export function appendWorktreeRows(
  result: Row[],
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  lineageById: Record<string, WorktreeLineage>,
  _worktreeMap: Map<string, Worktree>,
  options: {
    nestLineage: boolean
    collapsedGroups: Set<string>
    groupDepth: number
    sectionKey: string
    hostContextLabelByRepoId?: ReadonlyMap<string, string>
    hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>
    cyclicLineageIds: ReadonlySet<string>
  }
): void {
  const {
    nestLineage,
    collapsedGroups,
    groupDepth,
    sectionKey,
    hostContextLabelByRepoId,
    hostContextLabelByWorktreeIdentity,
    cyclicLineageIds
  } = options
  if (!nestLineage) {
    for (const worktree of worktrees) {
      result.push(
        buildWorktreeRow(worktree, repoMap, {
          rowKey: `${sectionKey}:${getWorktreeHostIdentity(worktree)}`,
          sectionKey,
          depth: 0,
          groupDepth,
          lineageTrail: [],
          isLastLineageChild: false,
          lineageChildCount: 0,
          lineageCollapsed: false,
          hostContextLabel:
            hostContextLabelByWorktreeIdentity?.get(getWorktreeHostIdentity(worktree)) ??
            hostContextLabelByRepoId?.get(worktree.repoId)
        })
      )
    }
    return
  }

  const visibleByIdentity = new Map(
    worktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
  )
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  const childIdentities = new Set<string>()
  for (const worktree of worktrees) {
    const projectedLineage = getProjectedWorktreeLineage(worktree, lineageById)
    const inlineLineage = (worktree as Worktree & { lineage?: WorktreeLineage | null }).lineage
    const lineage =
      projectedLineage?.worktreeInstanceId === worktree.instanceId
        ? projectedLineage
        : inlineLineage
    if (!lineage || cyclicLineageIds.has(worktree.id)) {
      continue
    }
    const parentIdentity = getWorktreeHostIdentity({
      id: lineage.parentWorktreeId,
      hostId: worktree.hostId
    })
    const parent = visibleByIdentity.get(parentIdentity)
    if (!parent || !isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)) {
      continue
    }
    const childIdentity = getWorktreeHostIdentity(worktree)
    childIdentities.add(childIdentity)
    const children = childrenByParentIdentity.get(parentIdentity) ?? []
    children.push(worktree)
    childrenByParentIdentity.set(parentIdentity, children)
  }

  const emitted = new Set<string>()
  const pending: {
    worktree: Worktree
    depth: number
    lineageTrail: boolean[]
    isLastChild: boolean
  }[] = []
  const emitPending = (): void => {
    while (pending.length > 0) {
      const next = pending.pop()
      // Why (STA-4343): membership and keys are host-qualified. Keyed by bare id,
      // the second host's row for a colliding id is silently never emitted.
      if (!next || emitted.has(getWorktreeHostIdentity(next.worktree))) {
        continue
      }
      const { worktree, depth, lineageTrail, isLastChild } = next
      const worktreeIdentity = getWorktreeHostIdentity(worktree)
      const children = childrenByParentIdentity.get(worktreeIdentity) ?? []
      const lineageGroupKey = getWorktreeLineageGroupKey(worktree)
      const lineageCollapsed = collapsedGroups.has(lineageGroupKey)
      emitted.add(worktreeIdentity)
      result.push(
        buildWorktreeRow(worktree, repoMap, {
          rowKey: `${sectionKey}:${worktreeIdentity}`,
          sectionKey,
          depth,
          groupDepth,
          lineageTrail,
          isLastLineageChild: isLastChild,
          lineageChildCount: children.length,
          lineageCollapsed,
          hostContextLabel:
            hostContextLabelByWorktreeIdentity?.get(worktreeIdentity) ??
            hostContextLabelByRepoId?.get(worktree.repoId)
        })
      )
      if (lineageCollapsed) {
        continue
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({
          worktree: children[index],
          depth: depth + 1,
          lineageTrail: [...lineageTrail, index < children.length - 1],
          isLastChild: index === children.length - 1
        })
      }
    }
  }
  const emit = (
    worktree: Worktree,
    depth: number,
    lineageTrail: boolean[],
    isLastChild: boolean
  ): void => {
    if (emitted.has(getWorktreeHostIdentity(worktree))) {
      return
    }
    pending.push({ worktree, depth, lineageTrail, isLastChild })
    emitPending()
  }

  const roots = worktrees.filter(
    (worktree) => !childIdentities.has(getWorktreeHostIdentity(worktree))
  )
  for (const [index, worktree] of roots.entries()) {
    emit(worktree, 0, [], index === roots.length - 1)
  }
  if (roots.length === 0) {
    for (const worktree of worktrees) {
      if (!emitted.has(getWorktreeHostIdentity(worktree))) {
        // Why: malformed cyclic lineage should not hide every participant.
        // Render any leftovers as roots rather than recursing forever.
        emit(worktree, 0, [], true)
      }
    }
  }
}

/** The one folder-workspace row constructor, shared by the project-group,
 *  grouped-lane and flat emitters so their rows cannot diverge. */
export function buildFolderWorkspaceRow(
  pair: RenderableFolderWorkspace,
  groupDepth: number
): FolderWorkspaceRow {
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${pair.folderWorkspace.id}`,
    folderWorkspace: pair.folderWorkspace,
    projectGroup: pair.projectGroup,
    depth: 0,
    groupDepth
  }
}
