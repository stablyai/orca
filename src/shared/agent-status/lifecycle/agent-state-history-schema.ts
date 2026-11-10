import { z } from 'zod'
import {
  normalizeMainAgentStatusField,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
} from '../contracts/agent-status-types'
import {
  normalizePromptField,
  normalizeOptionalMultilineField
} from '../contracts/agent-status-field-normalization'

export const agentStateHistoryEntrySchema = z
  .object({
    state: z.enum(['working', 'blocked', 'waiting', 'done']),
    prompt: z.string().transform(normalizePromptField),
    startedAt: z.number().finite(),
    observedAt: z.number().finite().optional(),
    turnStartedAt: z.number().finite().optional(),
    turnEndedAt: z.number().finite().optional(),
    turnEndDisposition: z.enum(['identified', 'ambiguous']).optional(),
    turnCompletedAt: z.number().finite().optional(),
    interrupted: z.boolean().optional(),
    mainAgent: z.unknown().transform(normalizeMainAgentStatusField).optional()
  })
  .strict()

export const previousPaneCompletionSchema = z
  .object({
    kind: z.literal('previous'),
    end: agentStateHistoryEntrySchema.extend({ state: z.literal('done') }),
    lastAssistantMessage: z
      .string()
      .transform((value) =>
        normalizeOptionalMultilineField(value, AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH)
      )
      .optional(),
    lastAssistantMessageIsToolOutput: z.boolean().optional()
  })
  .strict()

const completion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('passive') }).strict(),
  z
    .object({ kind: z.literal('current'), turnCompletedAt: z.number().finite().optional() })
    .strict(),
  previousPaneCompletionSchema
])
/** Corrupt/future completion metadata must never destroy a usable resume recipe. */
export const paneAgentCompletionSchema = z.preprocess((value) => {
  const parsed = completion.safeParse(value)
  return parsed.success ? parsed.data : undefined
}, completion.optional())
