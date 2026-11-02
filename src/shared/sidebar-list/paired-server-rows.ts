import { z } from 'zod'
import type { ExecutionHostId } from '../execution-host'
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { openEnum } from '../zod-salvage'

/** One paired-server workspace as the sidebar lists it, keyed by its host-qualified id. */
const PairedServerWorkspaceRowSchema = z.object({
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

// Older servers omit `workspaceKind` and may send arms this build has not heard of.
const ServerWorktreePsRowSchema = z.object({
  worktreeId: z.string().min(1),
  repoId: z.string(),
  workspaceKind: openEnum(['git', 'folder-workspace'], 'git').optional(),
  path: z.string().catch(''),
  branch: z.string().catch(''),
  displayName: z.string().catch(''),
  isArchived: z.boolean().catch(false),
  isPinned: z.boolean().catch(false)
})

/** A server's own `worktree.ps` row, with defaults for what older servers omit; null without an id. */
export function normalizePairedServerRow(
  hostId: ExecutionHostId,
  row: unknown
): PairedServerWorkspaceRow | null {
  const parsed = ServerWorktreePsRowSchema.safeParse(row)
  if (!parsed.success) {
    return null
  }
  const { workspaceKind, ...fields } = parsed.data
  return {
    key: composeWorktreeHostIdentity(hostId, fields.worktreeId),
    kind: workspaceKind === 'folder-workspace' ? 'folder' : 'git',
    ...fields
  }
}
