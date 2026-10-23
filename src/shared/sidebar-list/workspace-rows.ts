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

/**
 * One workspace this host lists, as the sidebar reads it: catalog, metadata and the host's sort
 * stamps. Activity and PR state are their own domains, so plain terminal output never changes a row.
 */
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
  /** The stored lineage record's edge; the builder decides whether it is valid. */
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
  /** The saved order Manual falls back to where a row has no manualOrder; older hosts omit it. */
  sortOrder: z.number().optional(),
  createdAt: z.number().optional(),
  creatorProvenance: z
    .union([
      z.object({ kind: z.literal('host') }),
      z.object({ kind: z.literal('paired-device'), deviceId: z.string() })
    ])
    .optional(),
  linkedIssue: z.number().nullable(),
  /** The linked PR number from metadata; a branch's PR from the cache is the review domain. */
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
  /** Main's alone: the platform a terminal in the workspace runs on. */
  terminalPlatform: z.string().optional(),
  /** The owning host's sort stamps (sort-stamps.ts); optional, as older hosts write no tier. */
  recentAt: z.number().optional(),
  smartTier: z.enum(SMART_TIERS).optional(),
  smartAt: z.number().optional()
})

/** Keyed by the row's identity as every client keys it: a local row whose metadata names no host
 *  keeps `|id`, while `hostId` still says which host owns it. */
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

/** Where this host lists a workspace, or null for one it does not (a paired server's). */
function listedRow(worktree: ListedWorktree, repo: ListedRepo | undefined): ListedRow | null {
  const hostId = worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
    return null
  }
  // As the window stamps rows (worktree-host-ownership.ts): a remote repo's host always, a local
  // row only the host its metadata names.
  const identityHostId = hostId === LOCAL_EXECUTION_HOST_ID ? worktree.hostId : hostId
  return { identity: composeWorktreeHostIdentity(identityHostId, worktree.id), hostId }
}

/** Each git worktree with the repo it belongs to; the same repo id can be registered on two hosts. */
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

/** Each git worktree this host lists, under the key `buildWorkspaceRows` lists it and with its own repo. */
export function listGitWorkspaceRows<W extends ListedWorktree, R extends ListedRepo>(
  worktrees: readonly W[],
  repos: readonly R[]
): { identity: HostScopedWorktreeKey; worktree: W; repo: R | undefined }[] {
  return withOwnerRepos(worktrees, repos).flatMap(({ worktree, repo }) => {
    const listed = listedRow(worktree, repo)
    return listed ? [{ identity: listed.identity, worktree, repo }] : []
  })
}

/** The keys `buildWorkspaceRows` lists these git worktrees under. */
export function listGitWorkspaceRowKeys(
  worktrees: readonly Worktree[],
  repos: readonly Repo[]
): HostScopedWorktreeKey[] {
  return listGitWorkspaceRows(worktrees, repos).map(({ identity }) => identity)
}

/**
 * Every workspace this host lists, from its own catalog: git worktrees (folder projects included)
 * and folder workspaces. A paired server's rows are another domain, so they are left out.
 */
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
