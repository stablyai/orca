import { z } from 'zod'
import { RequestedHostId } from './project-runtime-params'
import { isTuiAgent } from '../tui-agent-config'

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
