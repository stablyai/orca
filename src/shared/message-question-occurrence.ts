import { z } from 'zod'
import type { AskPrompt } from './native-chat/input/native-chat-ask-types'

const question = z.strictObject({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean(),
  options: z.array(z.strictObject({ label: z.string(), description: z.string().optional() })),
  hasPreviews: z.literal(true).optional()
})

const terminalReason = z.enum(['delivery', 'user', 'interruption', 'context', 'source-replaced'])
export const messageQuestionResolutionSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('pending'),
    reason: z.null(),
    factId: z.null(),
    resolvedBy: z.null(),
    resolvedAt: z.null()
  }),
  z.strictObject({
    state: z.enum(['resolved', 'cancelled']),
    reason: terminalReason,
    factId: z.string(),
    resolvedBy: z.string().nullable(),
    resolvedAt: z.number().nullable()
  })
])

/** Identity belongs to the accepted call; edits replace only its definition. */
export const messageQuestionOccurrenceSchema = z.strictObject({
  id: z.string(),
  sourceId: z.string(),
  context: z.string(),
  sourceRowId: z.string(),
  callSlot: z.int().nonnegative(),
  order: z.tuple([z.number(), z.number()]),
  timestamp: z.number().nullable(),
  turnId: z.string().nullable(),
  responseMode: z.literal('message'),
  questions: z.array(question).min(1),
  resolution: messageQuestionResolutionSchema
})

export type MessageQuestionOccurrence = z.infer<typeof messageQuestionOccurrenceSchema>
export type MessageQuestionResolution = z.infer<typeof messageQuestionResolutionSchema>
export type MessageQuestionView = {
  records: readonly MessageQuestionOccurrence[]
  ready: boolean
}

export function messageQuestionPrompt(
  records: readonly MessageQuestionOccurrence[],
  hidden?: ReadonlySet<string>
): AskPrompt | null {
  const questions: AskPrompt['questions'] = []
  const occurrenceIds: string[] = []
  for (const record of records) {
    if (record.resolution.state === 'pending' && !hidden?.has(record.id)) {
      occurrenceIds.push(record.id)
      questions.push(...record.questions)
    }
  }
  return questions.length ? { questions, occurrenceIds, replyAsMessage: true } : null
}
export const PENDING_MESSAGE_QUESTION = {
  state: 'pending',
  reason: null,
  factId: null,
  resolvedBy: null,
  resolvedAt: null
} as const
