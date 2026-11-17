import { z } from 'zod'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { RequestedHostId } from './projects/project-runtime-params'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'

export const AgentResolveDefault = z
  .object({
    repo: z.string().min(1).optional(),
    repoHostId: RequestedHostId.optional(),
    worktree: z.string().min(1).optional(),
    validateAgent: z.string().refine(isTuiAgent).optional()
  })
  .strict()
  .refine(
    (value) => !(value.repo && value.worktree) && (!value.repoHostId || value.repo),
    'Choose a target repository or workspace'
  )

export const ResolvedProjectDefaultAgentSelection = z.object({
  agent: z.custom<TuiAgent>(isTuiAgent),
  source: z.enum(['project', 'global', 'automatic', 'explicit']),
  projectId: z.string().optional(),
  projectName: z.string().optional()
})

export type ProjectDefaultAgentSelection = z.infer<typeof ResolvedProjectDefaultAgentSelection>
