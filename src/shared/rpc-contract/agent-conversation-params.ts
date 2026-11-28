import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { AGENT_STATUS_STATES } from '../agent-status/contracts/agent-status-types'
import { AGENT_READ_MAX_LIMIT } from '../agent-conversations/agent-conversation-contracts'
import { requiredString } from './rpc-param-primitives'

// Not strict: a newer CLI's filters must not break an older host's list.
export const AgentListParams = lazyZodSchema(() =>
  z.object({
    worktreeId: z.string().min(1).optional(),
    state: z.enum(AGENT_STATUS_STATES).optional()
  })
)

export const AgentShowParams = lazyZodSchema(() =>
  z.object({
    id: requiredString('Missing agent ID')
  })
)

export const AgentReadParams = lazyZodSchema(() =>
  z.object({
    id: requiredString('Missing agent ID'),
    limit: z.number().int().positive().max(AGENT_READ_MAX_LIMIT).optional()
  })
)
