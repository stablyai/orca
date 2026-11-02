import { z } from 'zod'
import {
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
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorkspaceRowKindFacts } from '../worktree/workspace-kinds'
import { SMART_TIERS } from './sort-stamps'

/**
 * One workspace this host lists, as the sidebar reads it: catalog, metadata and the host's sort
 * stamps. Activity and PR state are their own domains, so plain terminal output never changes a row.
 */
const WorkspaceRowSchema = z.object({
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

/** Keyed by host-qualified id, the form the frozen sort order and paired-server rows use. */
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

/**
 * Every workspace this host lists, from its own catalog: git worktrees (folder projects included)
 * and folder workspaces. A paired server's rows are another domain, so they are left out.
 */
export function buildWorkspaceRows(catalog: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repos: readonly Repo[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
}): Map<string, WorkspaceRow> {
  const reposById = new Map<string, Repo[]>()
  for (const repo of catalog.repos) {
    reposById.set(repo.id, [...(reposById.get(repo.id) ?? []), repo])
  }
  const rows = new Map<string, WorkspaceRow>()
  const add = (
    worktree: Worktree,
    kind: WorkspaceRow['kind'],
    repo?: Repo,
    lineage?: WorktreeLineage
  ): void => {
    const hostId = worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
    if (hostId && parseExecutionHostId(hostId)?.kind !== 'runtime') {
      rows.set(
        composeWorktreeHostIdentity(hostId, worktree.id),
        toWorkspaceRow(worktree, hostId, kind, repo, lineage)
      )
    }
  }
  for (const worktree of catalog.worktrees) {
    const owners = reposById.get(worktree.repoId) ?? []
    // The same repo id can be registered on two hosts; the row's host picks its owner.
    const repo =
      owners.find((owner) => getRepoExecutionHostId(owner) === worktree.hostId) ??
      (worktree.hostId === undefined && owners.length === 1 ? owners[0] : undefined)
    add(worktree, 'git', repo, catalog.lineageById[worktree.id])
  }
  for (const folderWorkspace of catalog.folderWorkspaces) {
    add(folderWorkspaceToWorktree(folderWorkspace), 'folder')
  }
  return rows
}
