import { z } from 'zod'
import { Identifier } from './structured-agent-session-identifiers'
import { MutationEnvelope } from './structured-agent-session-mutation-envelope'
import { AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH as MAX_RESPONSE_OPTION_ID_LENGTH } from '../agent-session-question-answer'
import { AgentSessionFormContentSchema } from '../agent-session-form'

export const RespondParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id'),
    /** Compare-and-set: the revision the client had on screen. */
    expectedRevision: z.number().int().positive(),
    optionId: Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH).optional(),
    content: AgentSessionFormContentSchema.optional()
  })
  .strict()
  .refine(
    (value) => (value.optionId !== undefined) !== (value.content !== undefined),
    'Choose one response.'
  )
