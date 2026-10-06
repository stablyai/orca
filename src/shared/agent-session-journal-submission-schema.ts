// The deep validator for a journal submission (`AgentJournalSubmission`), the row a sent message's
// dispatch state lives on. Open string fields stay type-checked, never enum-checked, as in
// `agent-session-journal-schemas.ts`.

import { z } from 'zod'
import { AgentJournalAnsweredTurnSchema } from './agent-session-answered-turn-schema'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'
import type { AgentJournalSubmission } from './agent-session-journal-types'

// Every persisted field is listed, or a parse strips it: this schema drops unknown keys.
export const AgentJournalSubmissionSchema = z.object({
  clientMessageId: z.string().min(1),
  fence: z.number().int(),
  payloadFingerprint: z.string(),
  dispatchState: z.string().min(1),
  providerItemId: z.string().nullable(),
  reason: z.string().nullable(),
  submittedAt: z.number(),
  resolvedAt: z.number().nullable(),
  submittedSequence: z.number().int().optional(),
  answeredInTurn: AgentJournalAnsweredTurnSchema.optional(),
  recovered: z.literal(true).optional(),
  handoverRecorded: z.literal(true).optional(),
  handedOverAt: z.number().optional(),
  rejection: AgentSessionFailureFactSchema.optional(),
  queuedMessageId: z.string().min(1).optional(),
  // The kind only; an object's other keys (a sender) are stripped, never published.
  source: z.object({ kind: z.string() }).optional(),
  keptAsQueuedMessageId: z.string().min(1).optional()
})

export function isAdmissibleAgentJournalSubmission(
  value: unknown
): value is AgentJournalSubmission {
  return AgentJournalSubmissionSchema.safeParse(value).success
}

/** Compile-time proof that every submission this build writes is admissible. */
type Admits<T extends true> = T
export type CanonicalJournalSubmissionIsAdmissible = Admits<
  AgentJournalSubmission extends z.input<typeof AgentJournalSubmissionSchema> ? true : false
>
