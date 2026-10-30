import { z } from 'zod'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { FolderWorkspace } from '../folder-workspace-types'
import { folderWorkspaceToWorktree } from '../folder-workspace-worktree'
import type { Repo } from '../repo-types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorkspaceRowKindFacts } from '../worktree/workspace-kinds'
import { openEnum } from '../zod-salvage'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../workspace-statuses'
import { SMART_TIERS } from './sort-stamps'
import { WorkspaceRowSchema } from './workspace-rows'
import { HostReportedActivitySchema, type HostReportedActivity } from './workspace-activity-facts'

/** One paired-server workspace as the sidebar lists it, keyed by its host-qualified id. */
const PairedServerWorkspaceRowSchema = z
  .object({
    key: z.string(),
    worktreeId: z.string(),
    repoId: z.string(),
    kind: z.enum(['git', 'folder']),
    path: z.string(),
    branch: z.string(),
    displayName: z.string(),
    isArchived: z.boolean(),
    isPinned: z.boolean()
  })
  .extend(
    // Server-owned sorting/filter/lineage facts; older desktops omit them. Lineage is the checked edge, not the raw record.
    WorkspaceRowSchema.pick({
      isMainWorktree: true,
      isUnread: true,
      instanceId: true,
      lineage: true,
      workspaceStatus: true,
      sortOrder: true,
      manualOrder: true,
      createdAt: true,
      creatorProvenance: true,
      defaultBranch: true,
      automationCreated: true,
      cliCreated: true,
      detachedHead: true,
      recentAt: true,
      smartTier: true,
      smartAt: true
    }).partial().shape
  )
  .extend({
    /** The server's own terminals and agents there; older desktops omit it. */
    activity: HostReportedActivitySchema.optional().catch(undefined)
  })

/** See PairedServerHost; health and compatibility stay open strings, as a reader only compares them. */
const PairedServerHostFactsSchema = z.object({
  label: z.string(),
  health: z.string(),
  compatibility: z.string().nullable(),
  pairedDeviceId: z.string().nullable()
})

/** Every configured server main lists rows for. Unverifiable: its last rows, not confirmed current. */
export const PairedServerRowsSnapshotSchema = z.object({
  revision: z.number(),
  servers: z.array(
    z.object({
      hostId: z.string(),
      freshness: z.enum(['live', 'unverifiable']),
      /** Null while the desktop does not show the server (a managed one folded into its SSH host). */
      host: PairedServerHostFactsSchema.nullable(),
      rows: z.array(PairedServerWorkspaceRowSchema)
    })
  )
})

export type PairedServerHostFacts = z.infer<typeof PairedServerHostFactsSchema>

export type PairedServerWorkspaceRow = z.infer<typeof PairedServerWorkspaceRowSchema>
export type PairedServerRowsSnapshot = z.infer<typeof PairedServerRowsSnapshotSchema>

/** A paired server's workspace as the window holds it, in the shape the server's own list reports. */
export function pairedServerRowOfWorktree(
  worktree: Worktree,
  kind: PairedServerWorkspaceRow['kind'],
  repo: Pick<Repo, 'kind'> | undefined,
  lineage: WorktreeLineage | null | undefined
): PairedServerWorkspaceRow {
  const key = getWorktreeHostIdentity(worktree)
  // The server's reply carries no automation name, so the row leaves it out too.
  const { automationName: _automationName, ...kindFacts } = getWorkspaceRowKindFacts(worktree, repo)
  return {
    key,
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    kind,
    path: worktree.path,
    branch: worktree.branch,
    displayName: worktree.displayName,
    isArchived: worktree.isArchived,
    isPinned: worktree.isPinned,
    isMainWorktree: worktree.isMainWorktree,
    isUnread: worktree.isUnread,
    instanceId: worktree.instanceId,
    lineage: lineage
      ? {
          parentWorktreeId: lineage.parentWorktreeId,
          worktreeInstanceId: lineage.worktreeInstanceId,
          parentWorktreeInstanceId: lineage.parentWorktreeInstanceId
        }
      : null,
    workspaceStatus: worktree.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    sortOrder: worktree.sortOrder,
    manualOrder: worktree.manualOrder,
    createdAt: worktree.createdAt,
    creatorProvenance: worktree.creatorProvenance,
    ...kindFacts,
    recentAt: worktree.lastActivityAt,
    smartTier: worktree.smartTier,
    smartAt: worktree.smartAt
  }
}

/** Host-qualified paired rows omitted by buildWorkspaceRows. */
export function buildPairedServerRows(catalog: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repos: readonly Repo[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
}): Map<string, PairedServerWorkspaceRow> {
  const rows = new Map<string, PairedServerWorkspaceRow>()
  const add = (worktree: Worktree, kind: PairedServerWorkspaceRow['kind']): void => {
    if (parseExecutionHostId(worktree.hostId)?.kind === 'runtime') {
      const repo = catalog.repos.find(
        (entry) => entry.id === worktree.repoId && getRepoExecutionHostId(entry) === worktree.hostId
      )
      const row = pairedServerRowOfWorktree(worktree, kind, repo, catalog.lineageById[worktree.id])
      rows.set(row.key, row)
    }
  }
  catalog.worktrees.forEach((worktree) => add(worktree, 'git'))
  catalog.folderWorkspaces.forEach((folder) => add(folderWorkspaceToWorktree(folder), 'folder'))
  return rows
}

// Older servers omit `workspaceKind` and may send arms this build has not heard of.
const ServerWorktreePsRowSchema = z.object({
  worktreeId: z.string().min(1),
  repoId: z.string(),
  workspaceKind: openEnum(['git', 'folder-workspace'], 'git').optional(),
  path: z.string().catch(''),
  branch: z.string().catch(''),
  displayName: z.string().catch(''),
  isArchived: z.boolean().catch(false),
  isPinned: z.boolean().catch(false),
  isMainWorktree: z.boolean().catch(false),
  unread: z.boolean().optional().catch(undefined),
  worktreeInstanceId: z.string().optional().catch(undefined),
  parentWorktreeId: z.string().nullable().optional().catch(undefined),
  lineageWorktreeInstanceId: z.string().optional().catch(undefined),
  parentWorktreeInstanceId: z.string().optional().catch(undefined),
  workspaceStatus: z.string().catch(DEFAULT_WORKSPACE_STATUS_ID),
  sortOrder: z.number().optional().catch(undefined),
  manualOrder: z.number().optional().catch(undefined),
  createdAt: z.number().optional().catch(undefined),
  creatorProvenance: WorkspaceRowSchema.shape.creatorProvenance.catch(undefined),
  defaultBranch: z.boolean().optional().catch(undefined),
  automationCreated: z.literal(true).optional().catch(undefined),
  cliCreated: z.literal(true).optional().catch(undefined),
  detachedHead: z.literal(true).optional().catch(undefined),
  lastActivityAt: z.number().optional().catch(undefined),
  smartTier: z.enum(SMART_TIERS).optional().catch(undefined),
  smartAt: z.number().optional().catch(undefined),
  liveTerminalCount: z.number().optional().catch(undefined),
  unverifiableTerminalCount: z.number().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  workingMode: z.string().optional().catch(undefined)
})

function reportedActivity(row: z.infer<typeof ServerWorktreePsRowSchema>): HostReportedActivity {
  const working = row.workingMode === 'monitoring' ? 'monitoring' : 'working'
  return {
    terminal:
      (row.liveTerminalCount ?? 0) > 0
        ? 'live'
        : (row.unverifiableTerminalCount ?? 0) > 0
          ? 'unverifiable'
          : null,
    agent: row.status === 'permission' ? 'permission' : row.status === 'working' ? working : null
  }
}

/** A server's own `worktree.ps` row, with defaults for what older servers omit; null without an id. */
export function normalizePairedServerRow(
  hostId: ExecutionHostId,
  row: unknown
): PairedServerWorkspaceRow | null {
  const parsed = ServerWorktreePsRowSchema.safeParse(row)
  if (!parsed.success) {
    return null
  }
  const {
    workspaceKind,
    lastActivityAt,
    unread,
    worktreeInstanceId,
    parentWorktreeId,
    lineageWorktreeInstanceId,
    parentWorktreeInstanceId,
    liveTerminalCount: _liveTerminalCount,
    unverifiableTerminalCount: _unverifiableTerminalCount,
    status: _status,
    workingMode: _workingMode,
    ...fields
  } = parsed.data
  return {
    key: composeWorktreeHostIdentity(hostId, fields.worktreeId),
    kind: workspaceKind === 'folder-workspace' ? 'folder' : 'git',
    ...fields,
    ...(unread !== undefined ? { isUnread: unread } : {}),
    ...(worktreeInstanceId !== undefined ? { instanceId: worktreeInstanceId } : {}),
    lineage:
      parentWorktreeId && lineageWorktreeInstanceId && parentWorktreeInstanceId
        ? {
            parentWorktreeId,
            worktreeInstanceId: lineageWorktreeInstanceId,
            parentWorktreeInstanceId
          }
        : null,
    recentAt: lastActivityAt,
    activity: reportedActivity(parsed.data)
  }
}
