import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  normalizeWorkspaceCleanupBrowseState,
  type WorkspaceCleanupBrowseState
} from '../../workspace-cleanup/workspace-cleanup-browse-state'

export const WorkspaceCleanupDismissal = lazyZodSchema(() =>
  z.object({
    worktreeId: z.string(),
    dismissedAt: z.number().finite(),
    fingerprint: z.string(),
    classifierVersion: z.number().finite(),
    executionHostId: z.string().min(1).optional()
  })
)

/** Normalize filters field by field: strict/enumerated input would reject all ui.set state when newer clients add filters. */
export const WorkspaceCleanupBrowse = lazyZodSchema(() =>
  z
    .custom<WorkspaceCleanupBrowseState>()
    .transform((value) => normalizeWorkspaceCleanupBrowseState(value))
)

export const WorkspaceCleanup = lazyZodSchema(() =>
  z.object({
    dismissals: z.record(z.string(), WorkspaceCleanupDismissal),
    browse: WorkspaceCleanupBrowse.optional()
  })
)
