import { z } from 'zod'

export const ProjectGroupArchiveDecisionsSchema = z.record(
  z.string(),
  z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('skip') }),
    z.object({ decision: z.literal('run'), approvedContentHash: z.string().optional() })
  ])
)

export type ProjectGroupArchiveDecisions = z.infer<typeof ProjectGroupArchiveDecisionsSchema>
export type ProjectGroupDeleteOptions = { archiveDecisions?: ProjectGroupArchiveDecisions }
export type FolderWorkspaceDeleteOptions = {
  requireUniqueId?: boolean
  runHooks?: boolean
  skipArchive?: boolean
  allowFailedArchiveHook?: boolean
}

export function projectGroupDeleteTimeoutMs(workspaceCount: number): number {
  return 30_000 + 150_000 * Math.max(1, workspaceCount)
}
