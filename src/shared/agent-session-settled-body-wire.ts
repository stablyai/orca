import { z } from 'zod'
import { AGENT_SESSION_JSON_PIECE_UNITS } from './agent-session-json-pieces'

export const AGENT_SESSION_SETTLED_BODY_CAPABILITY = 'agent-session.settled-body.v1' as const
export const AGENT_SESSION_SETTLED_BODY_MAX_UNITS = 4 * 1024 * 1024 + 64 * 1024
export const AgentSessionSettledBodyDescriptorSchema = z
  .object({
    contract: z.literal(AGENT_SESSION_SETTLED_BODY_CAPABILITY),
    version: z.literal('approval-json.v1'),
    state: z.enum(['resolved', 'cancelled'])
  })
  .strict()
export type AgentSessionSettledBodyDescriptor = z.infer<
  typeof AgentSessionSettledBodyDescriptorSchema
>
export const AgentSessionSettledBodySourceSchema = AgentSessionSettledBodyDescriptorSchema.extend({
  sessionId: z.string(),
  epoch: z.string(),
  itemId: z.string(),
  revision: z.number().int()
}).strict()
export type AgentSessionSettledBodySource = z.infer<typeof AgentSessionSettledBodySourceSchema>
export type AgentSessionSettledBodyRead = AgentSessionSettledBodySource & { cursor?: number }
export const AgentSessionSettledBodyPieceSchema = z
  .object({
    source: AgentSessionSettledBodySourceSchema,
    json: z.string().min(1).max(AGENT_SESSION_JSON_PIECE_UNITS),
    nextCursor: z.number().int().nonnegative().nullable(),
    total: z.number().int().positive().max(AGENT_SESSION_SETTLED_BODY_MAX_UNITS)
  })
  .strict()
export type AgentSessionSettledBodyPiece = z.infer<typeof AgentSessionSettledBodyPieceSchema>
export function sameAgentSessionSettledSource(
  a: AgentSessionSettledBodySource,
  b: AgentSessionSettledBodySource
): boolean {
  return (
    a.contract === b.contract &&
    a.version === b.version &&
    a.state === b.state &&
    a.sessionId === b.sessionId &&
    a.epoch === b.epoch &&
    a.itemId === b.itemId &&
    a.revision === b.revision
  )
}
