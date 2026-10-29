import { z } from 'zod'

export const PROJECT_MOVE_PAUSE_PROTOCOL = 1

export type ProjectMovePauseRequest = { requestId: string; protocol: 1 } & (
  | { phase: 'prepare'; worktreeIds: string[] }
  | { phase: 'persist'; successfulWorktreeIds: string[] }
  | { phase: 'release' }
)

const host = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('environment'), environmentId: z.string().min(1) })
])

export const projectMovePauseResponseSchema = z.discriminatedUnion('phase', [
  z.object({
    requestId: z.string(),
    protocol: z.literal(PROJECT_MOVE_PAUSE_PROTOCOL),
    phase: z.literal('prepare'),
    targets: z.array(
      z.object({ worktreeId: z.string(), terminalHost: host, chatHosts: z.array(host) })
    )
  }),
  z.object({
    requestId: z.string(),
    protocol: z.literal(PROJECT_MOVE_PAUSE_PROTOCOL),
    phase: z.literal('persist')
  }),
  z.object({
    requestId: z.string(),
    protocol: z.literal(PROJECT_MOVE_PAUSE_PROTOCOL),
    phase: z.literal('error'),
    error: z.string()
  })
])

export type ProjectMovePauseResponse = z.infer<typeof projectMovePauseResponseSchema>
