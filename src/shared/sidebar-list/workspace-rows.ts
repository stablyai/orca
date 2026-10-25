import { z } from 'zod'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { FolderWorkspace } from '../folder-workspace-types'
import { folderWorkspaceToWorktree } from '../folder-workspace-worktree'
import type { Repo } from '../repo-types'
import { WorkspaceAttachmentsSchema } from '../workspace-attachment-schema'
import { getWorkspaceAttachments } from '../workspace-attachments'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../workspace-statuses'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorkspaceRowKindFacts } from '../worktree/workspace-kinds'
import { SMART_TIERS } from './sort-stamps'

/** Catalog/metadata/sort stamps only; separate activity and review domains keep terminal output from invalidating rows. */
export const WorkspaceRowSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  kind: z.enum(['git', 'folder']),
  repoId: z.string(),
  path: z.string(),
  branch: z.string(),
  displayName: z.string(),
  isMainWorktree: z.boolean(),
  instanceId: z.string().optional(),
  /** Stored lineage edge; the builder validates it. */
  lineage: z
    .object({
      parentWorktreeId: z.string(),
      worktreeInstanceId: z.string(),
      parentWorktreeInstanceId: z.string()
    })
    .nullable(),
  isPinned: z.boolean(),
  isArchived: z.boolean(),
  isUnread: z.boolean(),
  workspaceStatus: z.string(),
  comment: z.string(),
  manualOrder: z.number().optional(),
  /** Manual fallback for rows lacking manualOrder; old hosts omit it. */
  sortOrder: z.number().optional(),
  createdAt: z.number().optional(),
  creatorProvenance: z
    .union([
      z.object({ kind: z.literal('host') }),
      z.object({ kind: z.literal('paired-device'), deviceId: z.string() })
    ])
    .optional(),
  linkedIssue: z.number().nullable(),
  /** Metadata link only; cached branch PR belongs to the review domain. */
  linkedPR: z.number().nullable(),
  linkedLinearIssue: z.string().nullable(),
  linkedGitLabMR: z.number().nullable(),
  linkedGitLabIssue: z.number().nullable(),
  linkedItems: WorkspaceAttachmentsSchema,
  defaultBranch: z.boolean(),
  automationCreated: z.literal(true).optional(),
  automationName: z.string().optional(),
  cliCreated: z.literal(true).optional(),
  detachedHead: z.literal(true).optional(),
  /** Main-owned terminal platform. */
  terminalPlatform: z.string().optional(),
  /** Host-owned sort stamps (sort-stamps.ts); old hosts omit tiers. */
  recentAt: z.number().optional(),
  smartTier: z.enum(SMART_TIERS).optional(),
  smartAt: z.number().optional()
})

/** Legacy local rows without metadata host retain `|id` keys even when hostId names their owner. */
export const WorkspaceRowsSnapshotSchema = z.object({
  revision: z.number(),
  rows: z.record(z.string(), WorkspaceRowSchema)
})

export type WorkspaceRow = z.infer<typeof WorkspaceRowSchema>
export type WorkspaceRowsSnapshot = z.infer<typeof WorkspaceRowsSnapshotSchema>

function toWorkspaceRow(
  worktree: Worktree,
  hostId: ExecutionHostId,
  kind: WorkspaceRow['kind'],
  repo: Repo | undefined,
  lineage: WorktreeLineage | undefined
): WorkspaceRow {
  const kindFacts = getWorkspaceRowKindFacts(worktree, repo)
  return {
    id: worktree.id,
    hostId,
    kind,
    repoId: worktree.repoId,
    path: worktree.path,
    branch: worktree.branch,
    displayName: worktree.displayName,
    isMainWorktree: worktree.isMainWorktree,
    ...(worktree.instanceId !== undefined ? { instanceId: worktree.instanceId } : {}),
    lineage: lineage
      ? {
          parentWorktreeId: lineage.parentWorktreeId,
          worktreeInstanceId: lineage.worktreeInstanceId,
          parentWorktreeInstanceId: lineage.parentWorktreeInstanceId
        }
      : null,
    isPinned: worktree.isPinned,
    isArchived: worktree.isArchived,
    isUnread: worktree.isUnread,
    workspaceStatus: worktree.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    comment: worktree.comment,
    ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
    sortOrder: worktree.sortOrder,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
    linkedIssue: worktree.linkedIssue,
    linkedPR: worktree.linkedPR,
    linkedLinearIssue: worktree.linkedLinearIssue,
    linkedGitLabMR: worktree.linkedGitLabMR ?? null,
    linkedGitLabIssue: worktree.linkedGitLabIssue ?? null,
    linkedItems: getWorkspaceAttachments(worktree),
    ...kindFacts,
    defaultBranch: kindFacts.defaultBranch ?? false,
    recentAt: worktree.lastActivityAt,
    ...(worktree.smartTier !== undefined
      ? { smartTier: worktree.smartTier, smartAt: worktree.smartAt }
      : {})
  }
}

type ListedRow = { identity: HostScopedWorktreeKey; hostId: ExecutionHostId }
type ListedWorktree = Pick<Worktree, 'id' | 'repoId' | 'hostId'>
type ListedRepo = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

/** Null for rows this host does not list, such as paired-server workspaces. */
function listedRow(worktree: ListedWorktree, repo: ListedRepo | undefined): ListedRow | null {
  const hostId = worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
    return null
  }
  // Match window ownership: stamp remote hosts always, local hosts only when metadata names one.
  const identityHostId = hostId === LOCAL_EXECUTION_HOST_ID ? worktree.hostId : hostId
  return { identity: composeWorktreeHostIdentity(identityHostId, worktree.id), hostId }
}

/** Resolve each row’s own repo; repo IDs can collide across hosts. */
function withOwnerRepos<W extends ListedWorktree, R extends ListedRepo>(
  worktrees: readonly W[],
  repos: readonly R[]
): { worktree: W; repo: R | undefined }[] {
  const reposById = new Map<string, R[]>()
  for (const repo of repos) {
    reposById.set(repo.id, [...(reposById.get(repo.id) ?? []), repo])
  }
  return worktrees.map((worktree) => {
    const owners = reposById.get(worktree.repoId) ?? []
    const repo =
      owners.find((owner) => getRepoExecutionHostId(owner) === worktree.hostId) ??
      (worktree.hostId === undefined && owners.length === 1 ? owners[0] : undefined)
    return { worktree, repo }
  })
}

/** Listed git worktrees with their own repos and buildWorkspaceRows keys. */
export function listGitWorkspaceRows<W extends ListedWorktree, R extends ListedRepo>(
  worktrees: readonly W[],
  repos: readonly R[]
): { identity: HostScopedWorktreeKey; worktree: W; repo: R | undefined }[] {
  return withOwnerRepos(worktrees, repos).flatMap(({ worktree, repo }) => {
    const listed = listedRow(worktree, repo)
    return listed ? [{ identity: listed.identity, worktree, repo }] : []
  })
}

export function listGitWorkspaceRowKeys(
  worktrees: readonly Worktree[],
  repos: readonly Repo[]
): HostScopedWorktreeKey[] {
  return listGitWorkspaceRows(worktrees, repos).map(({ identity }) => identity)
}

/** Own catalog only, including folder projects/workspaces; paired-server rows use another domain. */
export function buildWorkspaceRows(catalog: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repos: readonly Repo[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
}): Map<HostScopedWorktreeKey, WorkspaceRow> {
  const rows = new Map<HostScopedWorktreeKey, WorkspaceRow>()
  const add = (
    worktree: Worktree,
    kind: WorkspaceRow['kind'],
    repo?: Repo,
    lineage?: WorktreeLineage
  ): void => {
    const listed = listedRow(worktree, repo)
    if (listed) {
      rows.set(listed.identity, toWorkspaceRow(worktree, listed.hostId, kind, repo, lineage))
    }
  }
  for (const { worktree, repo } of withOwnerRepos(catalog.worktrees, catalog.repos)) {
    add(worktree, 'git', repo, catalog.lineageById[worktree.id])
  }
  for (const folderWorkspace of catalog.folderWorkspaces) {
    add(folderWorkspaceToWorktree(folderWorkspace), 'folder')
  }
  return rows
}
