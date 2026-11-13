import * as z from 'zod'
import { WorkspaceCleanupRulesParam } from './workspace-cleanup-policy-params'

/** Previews the host's rules, or `rules` in place of its global rules; project overrides still apply. */
export const WorkspaceCleanupPreviewParams = z
  .object({ rules: WorkspaceCleanupRulesParam.optional() })
  .strict()
  .default({})

/** Starts a run now, or joins the one already going. */
export const WorkspaceCleanupRunNowParams = z
  .object({ trigger: z.enum(['run-now', 'cli']).optional() })
  .strict()
  .default({})

/** The workspaces this client holds unsaved editor buffers in on this host; replaces its last report. */
export const WorkspaceCleanupReportUnsavedEditorsParams = z
  .object({ worktreeIds: z.array(z.string().min(1).max(4096)).max(5000) })
  .strict()
