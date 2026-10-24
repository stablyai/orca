import { z } from 'zod'
import { OptionalExecutionHostId } from './worktree-params'

/** The workspace an `agent.launch` would run in, or the repo its new worktree would come from. */
export const AgentResolveDefault = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('existing'),
      worktree: z.string().min(1, 'Missing worktree selector')
    }),
    z.object({
      kind: z.literal('create-worktree'),
      repo: z.string().min(1, 'Missing repo selector'),
      repoHostId: OptionalExecutionHostId
    })
  ])
})
