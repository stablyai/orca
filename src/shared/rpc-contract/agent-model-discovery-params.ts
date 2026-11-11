import { z } from 'zod'
import { OptionalExecutionHostId } from './worktree-params'

export const AgentDiscoverTerminalModels = z.object({
  agentId: z.string().min(1),
  worktree: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  repoHostId: OptionalExecutionHostId,
  folder: z
    .object({
      projectGroupId: z.string().min(1),
      folderPath: z.string().nullable().optional(),
      connectionId: z.string().nullable().optional()
    })
    .optional(),
  cwd: z.string().min(1).optional(),
  uncached: z.boolean().optional()
})

export type TerminalModelDiscoveryParams = z.infer<typeof AgentDiscoverTerminalModels>
