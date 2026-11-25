import { MAX_PROMPT_BYTES } from './structured-agent-session-message-params'
import { Identifier } from './structured-agent-session-identifiers'
import * as z from 'zod'
// Buffer-free: phones parse these too.
import { measureUtf8ByteLength } from '../../text/utf8-byte-limits'
import {
  AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES,
  AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH as MAX_RESPONSE_OPTION_ID_LENGTH
} from '../../agent-session/requests/prompts/agent-session-question-answer'
import { MutationEnvelope } from './structured-agent-session-mutation-envelope'

const MAX_QUESTION_ANSWER_QUESTIONS = 4

const MAX_QUESTION_ANSWER_OPTIONS = 64

const QuestionAnswer = z
  .object({
    // Codex question ids are model-written and untrimmed; the host matches them exactly.
    questionId: z
      .string()
      .min(1, 'Invalid question id')
      .max(MAX_RESPONSE_OPTION_ID_LENGTH, 'Invalid question id'),
    optionIds: z
      .array(Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH))
      .max(MAX_QUESTION_ANSWER_OPTIONS),
    // Hashed verbatim by both peers, so no trim or transform here.
    other: z
      .string()
      .max(AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES)
      .refine(
        (value) =>
          !measureUtf8ByteLength(value, { stopAfterBytes: AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES })
            .exceededLimit,
        'Answer is too large'
      )
      .optional()
  })
  .strict()

export const RespondToQuestionParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id'),
    expectedRevision: z.number().int().positive(),
    /** An answer packed into one id, from clients that predate `answers`. */
    optionId: Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH).optional(),
    answers: z.array(QuestionAnswer).min(1).max(MAX_QUESTION_ANSWER_QUESTIONS).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.optionId === undefined) === (value.answers === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Send exactly one of an option id or answers' })
    }
    if (
      value.answers !== undefined &&
      measureUtf8ByteLength(JSON.stringify(value.answers), { stopAfterBytes: MAX_PROMPT_BYTES })
        .exceededLimit
    ) {
      ctx.addIssue({ code: 'custom', message: 'Answer is too large' })
    }
  })
