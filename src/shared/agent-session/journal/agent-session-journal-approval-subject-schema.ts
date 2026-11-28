import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { knownTags, openDiscriminatedUnion } from './agent-session-journal-open-union'

const KnownApprovalSubject = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('plan'), text: z.string().min(1), filePath: z.string().optional() }),
    z.object({
      kind: z.literal('url'),
      url: z.string().min(1),
      completedAt: z.number().finite().optional()
    })
  ])
)
export const AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS = knownTags(KnownApprovalSubject)
/** Open like blocks; a subject this build cannot draw is never approvable here
 *  (agent-session-approval-subject.ts). */
export const AgentJournalApprovalSubjectSchema = openDiscriminatedUnion(KnownApprovalSubject)
