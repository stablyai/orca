import * as z from 'zod'
import {
  AGENT_LIST_STATES,
  AGENT_READ_MAX_LIMIT
} from '../agent-conversations/agent-conversation-contracts'
import { requiredString } from './rpc-param-primitives'

// Not strict: a newer CLI's filters must not break an older host's list.
export const AgentListParams = z.object({
  worktreeId: z.string().min(1).optional(),
  state: z.enum(AGENT_LIST_STATES).optional()
})

export const AgentShowParams = z.object({
  id: requiredString('Missing agent ID')
})

export const AgentReadParams = z.object({
  id: requiredString('Missing agent ID'),
  limit: z.number().int().positive().max(AGENT_READ_MAX_LIMIT).optional()
})
