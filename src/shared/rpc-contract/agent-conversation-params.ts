import * as z from 'zod'
import { AGENT_STATUS_STATES } from '../agent-status/contracts/agent-status-types'
import { AGENT_READ_MAX_LIMIT } from '../agent-conversations/agent-conversation-contracts'
import { requiredString } from './rpc-param-primitives'
import { Identifier } from './structured-agent-session/structured-agent-session-identifiers'

// Not strict: a newer CLI's filters must not break an older host's list.
export const AgentListParams = z.object({
  worktreeId: z.string().min(1).optional(),
  state: z.enum(AGENT_STATUS_STATES).optional()
})

export const AgentShowParams = z.object({
  id: requiredString('Missing agent ID')
})

export const AgentReadParams = z.object({
  id: requiredString('Missing agent ID'),
  limit: z.number().int().positive().max(AGENT_READ_MAX_LIMIT).optional()
})

export const AgentSendParams = z.object({
  id: requiredString('Missing agent ID'),
  text: requiredString('Missing message text'),
  // One durable chat operation ID per CLI run, so a retried request sends once.
  operationId: Identifier('Invalid operation ID')
})
