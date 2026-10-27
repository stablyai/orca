import { z } from 'zod'
import { normalizeWorkspaceCleanupBrowseState } from '../workspace-cleanup-browse-state'
import type { WorkspaceCleanupBrowseState } from '../workspace-cleanup-browse-state'

export const WorkspaceCleanupDismissal = z.object({
  worktreeId: z.string(),
  dismissedAt: z.number().finite(),
  fingerprint: z.string(),
  classifierVersion: z.number().finite(),
  executionHostId: z.string().min(1).optional()
})

/** Normalize filters field by field: strict/enumerated input would reject all ui.set state when newer clients add filters. */
export const WorkspaceCleanupBrowse = z
  .custom<WorkspaceCleanupBrowseState>()
  .transform((value) => normalizeWorkspaceCleanupBrowseState(value))

export const WorkspaceCleanup = z.object({
  dismissals: z.record(z.string(), WorkspaceCleanupDismissal),
  browse: WorkspaceCleanupBrowse.optional()
})
