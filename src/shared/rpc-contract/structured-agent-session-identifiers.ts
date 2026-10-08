import { z } from 'zod'
import { isAgentSessionId } from '../agent-session-record'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../agent-session-wire'

export const MAX_ID_LENGTH = AGENT_SESSION_ID_MAX_LENGTH

export const SessionId = z
  .string()
  .max(MAX_ID_LENGTH)
  .refine(isAgentSessionId, 'Invalid agent session id')

export const Identifier = (message: string, maxLength = MAX_ID_LENGTH) =>
  z
    .string()
    .min(1, message)
    .max(maxLength, message)
    .refine((value) => value === value.trim(), message)

export const JournalCursor = z
  .object({
    epoch: Identifier('Invalid journal epoch'),
    sequence: z.number().int().nonnegative()
  })
  .strict()

/** The turn a create forks: a chat this host holds and one of that turn's rows. An identity only;
 *  the host works out what the provider copies. */
export const ForkSource = z
  .object({ sessionId: SessionId, itemId: Identifier('Invalid item id') })
  .strict()
