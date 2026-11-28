import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { WorkspaceCleanupRulesParam } from './workspace-cleanup-policy-params'

/** Previews the host's rules, or `rules` in place of its global rules; project overrides still apply. */
export const WorkspaceCleanupPreviewParams = lazyZodSchema(() =>
  z.object({ rules: WorkspaceCleanupRulesParam.optional() }).strict().default({})
)

/** Starts a run now, or joins the one already going. */
export const WorkspaceCleanupRunNowParams = lazyZodSchema(() =>
  z
    .object({ trigger: z.enum(['run-now', 'cli']).optional() })
    .strict()
    .default({})
)

/** The workspaces this client holds unsaved editor buffers in on this host; replaces its last report. */
export const WorkspaceCleanupReportUnsavedEditorsParams = lazyZodSchema(() =>
  z
    .object({
      worktreeIds: z.array(z.string().min(1).max(4096)).max(5000),
      /** One per client window: windows sharing a socket each keep their own report. */
      reporterId: z.string().min(1).max(128).optional()
    })
    .strict()
)

/** One settings view reading the host's Codex history size; the host stops a walk no view still waits for. */
export const WorkspaceCleanupCodexHistoryDiskUsageParams = lazyZodSchema(() =>
  z
    .object({ consumerId: z.string().min(1).max(128).optional() })
    .strict()
    .default({})
)

/** That view stopped waiting (closed, hidden or switched host) before its size arrived. */
export const WorkspaceCleanupReleaseCodexHistoryDiskUsageParams = lazyZodSchema(() =>
  z.object({ consumerId: z.string().min(1).max(128) }).strict()
)
