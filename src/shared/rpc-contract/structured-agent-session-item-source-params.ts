import { z } from 'zod'
import { AGENT_SESSION_SETTLED_BODY_CAPABILITY } from '../agent-session-settled-body'
import { JournalCursor } from './structured-agent-session-identifiers'

export const ItemBodySourceParams = z
  .object({
    contract: z.literal(AGENT_SESSION_SETTLED_BODY_CAPABILITY),
    version: z.literal('approval-json.v1'),
    state: z.enum(['resolved', 'cancelled']),
    epoch: JournalCursor.shape.epoch,
    revision: z.number().int().nonnegative(),
    cursor: z.number().int().nonnegative().optional()
  })
  .strict()
