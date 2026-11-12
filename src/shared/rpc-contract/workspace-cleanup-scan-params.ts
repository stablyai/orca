import * as z from 'zod'
import { WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT } from '../workspace-cleanup/workspace-cleanup'

const WorktreeIdList = (max: number) => z.array(z.string().min(1).max(4096)).max(max).optional()

/** The cleanup scan a client asks of the host that owns the repos; progress stays on desktop IPC. */
export const WorkspaceCleanupScanParams = z.object({
  worktreeIds: WorktreeIdList(WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT),
  skipGitWorktreeIds: WorktreeIdList(20_000),
  includeAllWorkspaces: z.boolean().optional(),
  refreshActivity: z.boolean().optional()
})
