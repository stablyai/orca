import { AGENT_SESSION_ID_MAX_LENGTH as MAX_ID_LENGTH } from '../agent-session/agent-session-wire'
import { z } from 'zod'
import { normalizeExecutionHostId } from '../execution-host'
import { Identifier } from './structured-agent-session/structured-agent-session-identifiers'

export const ExecutionHostId = z
  .string()
  .max(MAX_ID_LENGTH)
  .transform((value) => normalizeExecutionHostId(value))
  .refine((value): value is NonNullable<typeof value> => value !== null, {
    message: 'Invalid execution host id'
  })

export const ExecutionLocation = z
  .object({
    executionHostId: ExecutionHostId,
    wslDistro: Identifier('Invalid WSL distro').nullable(),
    workspaceId: Identifier('Invalid workspace id'),
    workspaceKind: z.enum(['git-worktree', 'folder'])
  })
  .strict()
