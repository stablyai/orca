import {
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { FolderWorkspace } from '../folder-workspace-types'
import { projectGroupIdFromRepoId } from '../folder-workspace-worktree'
import { parseWorkspaceKey } from '../workspace-scope'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import type { PairedServerWorkspaceRow } from './paired-server-rows'
import type { WorkspaceRow } from './workspace-rows'

/** What the filters read off a row that the host decided, not the reader (workspace-kinds.ts). */
export type SidebarFeedRowFacts = Partial<
  Pick<
    WorkspaceRow,
    'defaultBranch' | 'automationCreated' | 'cliCreated' | 'detachedHead' | 'creatorProvenance'
  >
>

/** One feed workspace as the shared builder reads it, keyed by its identity. */
export type SidebarFeedWorkspace = {
  identity: string
  /** Carries the row's own lineage edge: same-id rows on two hosts each keep theirs. */
  worktree: Worktree
  facts: SidebarFeedRowFacts
  /** Set on a folder row: the builder lists folder workspaces apart from worktrees. */
  folderWorkspace: FolderWorkspace | null
}

/** The fields both a host's own rows and a paired server's rows carry for the list. */
type FeedRowFields = Pick<
  WorkspaceRow,
  'repoId' | 'kind' | 'path' | 'branch' | 'displayName' | 'isArchived' | 'isPinned'
> &
  Partial<
    Pick<
      WorkspaceRow,
      | 'isMainWorktree'
      | 'isUnread'
      | 'instanceId'
      | 'lineage'
      | 'workspaceStatus'
      | 'sortOrder'
      | 'manualOrder'
      | 'createdAt'
      | 'recentAt'
      | 'smartTier'
      | 'smartAt'
    >
  > &
  SidebarFeedRowFacts

function readFeedRow(
  identity: string,
  id: string,
  ownerHostId: ExecutionHostId,
  row: FeedRowFields,
  extra: Partial<
    Pick<
      Worktree,
      | 'comment'
      | 'linkedIssue'
      | 'linkedPR'
      | 'linkedLinearIssue'
      | 'linkedGitLabMR'
      | 'linkedGitLabIssue'
      | 'linkedItems'
    >
  > = {}
): SidebarFeedWorkspace {
  // The identity's host, not the owner: a local row whose metadata names no host keeps `|id`.
  const hostId = getExecutionHostIdFromWorktreeHostIdentity(identity)
  const owner = parseExecutionHostId(ownerHostId)
  const { defaultBranch, automationCreated, cliCreated, detachedHead, creatorProvenance } = row
  // The inline edge the lineage projection reads off a resolved row (worktree-lineage-projection.ts).
  const worktree: Worktree & { lineage: WorktreeLineage | null } = {
    id,
    ...(hostId ? { hostId } : {}),
    ...(owner?.kind === 'runtime' ? { runtimeOwnerEnvironmentId: owner.environmentId } : {}),
    ...(row.instanceId !== undefined ? { instanceId: row.instanceId } : {}),
    repoId: row.repoId,
    path: row.path,
    branch: row.branch,
    head: '',
    isBare: false,
    displayName: row.displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isMainWorktree: row.isMainWorktree ?? false,
    isArchived: row.isArchived,
    isPinned: row.isPinned,
    isUnread: row.isUnread ?? false,
    workspaceStatus: row.workspaceStatus,
    sortOrder: row.sortOrder ?? 0,
    ...(row.manualOrder !== undefined ? { manualOrder: row.manualOrder } : {}),
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(creatorProvenance ? { creatorProvenance } : {}),
    lastActivityAt: row.recentAt ?? 0,
    ...(row.smartTier !== undefined ? { smartTier: row.smartTier, smartAt: row.smartAt } : {}),
    ...extra,
    // The builder validates only the edge; provenance stays the host's.
    lineage: row.lineage
      ? {
          worktreeId: id,
          ...row.lineage,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 0
        }
      : null
  }
  return {
    identity,
    worktree,
    facts: { defaultBranch, automationCreated, cliCreated, detachedHead, creatorProvenance },
    folderWorkspace: row.kind === 'folder' ? folderWorkspaceOf(worktree, ownerHostId) : null
  }
}

function folderWorkspaceOf(
  worktree: Worktree,
  ownerHostId: ExecutionHostId
): FolderWorkspace | null {
  const id = parseWorkspaceKey(worktree.id)
  const projectGroupId = projectGroupIdFromRepoId(worktree.repoId)
  if (id?.type !== 'folder' || !projectGroupId) {
    return null
  }
  return {
    id: id.folderWorkspaceId,
    projectGroupId,
    name: worktree.displayName,
    folderPath: worktree.path,
    executionHostId: ownerHostId,
    connectionId: getSshTargetIdForExecutionHost(ownerHostId),
    ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
    linkedTask: null,
    ...(worktree.linkedItems ? { linkedItems: worktree.linkedItems } : {}),
    comment: worktree.comment,
    isArchived: worktree.isArchived,
    isUnread: worktree.isUnread,
    isPinned: worktree.isPinned,
    sortOrder: worktree.sortOrder,
    ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
    workspaceStatus: worktree.workspaceStatus,
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.smartTier !== undefined
      ? { smartTier: worktree.smartTier, smartAt: worktree.smartAt }
      : {}),
    createdAt: worktree.createdAt ?? 0,
    updatedAt: 0
  }
}

/** A row this host lists in its own catalog (workspace-rows.ts), back in the builder's shape. */
export function readFeedWorkspaceRow(
  identity: string,
  row: WorkspaceRow
): SidebarFeedWorkspace | null {
  const owner = parseExecutionHostId(row.hostId)
  return owner
    ? readFeedRow(identity, row.id, owner.id, row, {
        comment: row.comment,
        linkedIssue: row.linkedIssue,
        linkedPR: row.linkedPR,
        linkedLinearIssue: row.linkedLinearIssue,
        linkedGitLabMR: row.linkedGitLabMR,
        linkedGitLabIssue: row.linkedGitLabIssue,
        linkedItems: row.linkedItems
      })
    : null
}

/** A paired server's row, as the server's own list reports it; older desktops send fewer fields. */
export function readFeedPairedServerRow(
  row: PairedServerWorkspaceRow
): SidebarFeedWorkspace | null {
  const owner = parseExecutionHostId(getExecutionHostIdFromWorktreeHostIdentity(row.key))
  return owner?.kind === 'runtime' ? readFeedRow(row.key, row.worktreeId, owner.id, row) : null
}
