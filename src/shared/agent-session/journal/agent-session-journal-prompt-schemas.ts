import * as z from 'zod'
import { knownTags, openDiscriminatedUnion } from './agent-session-journal-open-union'
import { AGENT_JOURNAL_PROMPT_INTENTS } from './agent-session-journal-types'

export const PromptOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
  intent: z.enum(AGENT_JOURNAL_PROMPT_INTENTS).optional()
})

export const FreeTextInput = z.object({
  allowEmpty: z.boolean().optional(),
  multiline: z.boolean().optional(),
  initialValue: z.string().optional(),
  placeholder: z.string().optional()
})

export const Question = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean(),
  options: z.array(PromptOption),
  freeTextQuestionId: z.string().optional(),
  freeTextInput: FreeTextInput.optional()
})

export const Resolution = z.object({
  state: z.string().min(1),
  selectedOptionId: z.string().nullable(),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        optionIds: z.array(z.string()),
        other: z.string().optional()
      })
    )
    .optional(),
  feedback: z.string().optional(),
  resolvedBy: z.string().nullable(),
  resolvedByDevice: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('current') }),
      z.object({ kind: z.literal('named'), name: z.string() })
    ])
    .optional(),
  resolvedAt: z.number().nullable()
})

export const ApprovalMatchedAskRule = z.object({
  source: z.string(),
  toolName: z.string(),
  ruleContent: z.string().optional()
})

const KnownApprovalSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), text: z.string().min(1), filePath: z.string().optional() })
])
export const AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS = knownTags(KnownApprovalSubject)

/** Open like blocks; a subject this build cannot draw is never approvable here (agent-session-approval-subject.ts). */
export const ApprovalSubject = openDiscriminatedUnion(KnownApprovalSubject)
