// A chat's own answered permission prompt as one line: its shield and which sentence it reads. Each
// platform words the sentence under its own key, with the tool as `<tool>{{tool}}</tool>`.
import type { AgentJournalApprovalItem } from '../../journal/agent-session-journal-types'
import type { WorkerApprovalRecordTone } from '../../../orchestration/approvals/worker-approval-record'
import {
  ORCHESTRATION_APPROVAL_CALLER_PREFIX,
  ORCHESTRATION_COORDINATOR_APPROVAL_CALLER_PREFIX,
  ORCHESTRATION_PERSON_APPROVAL_CALLER_PREFIX
} from '../../../orchestration/approvals/worker-approval-payload'
import { approvalRecordTool } from './agent-session-approval-tool'

export type OwnApprovalRecordSentence =
  | 'cancelled'
  | 'coordinatorAllowed'
  | 'coordinatorDenied'
  | 'allowedUnnamed'
  | 'deniedUnnamed'
  | 'youAllowed'
  | 'youAllowedForSession'
  | 'youDenied'
  | 'youAnswered'

export type OwnApprovalRecord = {
  tone: WorkerApprovalRecordTone
  sentence: OwnApprovalRecordSentence
  tool: string
  /** The picked option's label for `youAnswered`; null when this build cannot read it. */
  answer?: string | null
}

/** The chat's own prompt, answered here, on another device, or by its coordinator through Orca. */
export function ownApprovalRecord(body: AgentJournalApprovalItem): OwnApprovalRecord {
  const { resolution } = body
  const tool = approvalRecordTool(body.toolName, body.displayName ?? body.title)
  if (resolution.state !== 'resolved') {
    return { tone: 'closed', sentence: 'cancelled', tool }
  }
  const option = body.options.find((entry) => entry.id === resolution.selectedOptionId)
  const resolvedBy = resolution.resolvedBy ?? ''
  // Orca answers a worker's prompt only by allowing or refusing this one call.
  const allows = option?.intent === 'allow_once'
  const tone = allows ? 'allowed' : 'denied'
  if (allows || option?.intent === 'reject_once') {
    if (resolvedBy.startsWith(ORCHESTRATION_COORDINATOR_APPROVAL_CALLER_PREFIX)) {
      return { tone, sentence: allows ? 'coordinatorAllowed' : 'coordinatorDenied', tool }
    }
    // Older builds named no one: the coordinator or a person in its chat.
    if (
      resolvedBy.startsWith(ORCHESTRATION_APPROVAL_CALLER_PREFIX) &&
      !resolvedBy.startsWith(ORCHESTRATION_PERSON_APPROVAL_CALLER_PREFIX)
    ) {
      return { tone, sentence: allows ? 'allowedUnnamed' : 'deniedUnnamed', tool }
    }
  }
  switch (option?.intent) {
    case 'allow_once':
      return { tone: 'allowed', sentence: 'youAllowed', tool }
    case 'allow_always':
      return { tone: 'allowed', sentence: 'youAllowedForSession', tool }
    case 'reject_once':
    case 'reject_always':
      return { tone: 'denied', sentence: 'youDenied', tool }
    case undefined:
      // An option that neither grants nor refuses (a stop), or one this build cannot read.
      return { tone: 'closed', sentence: 'youAnswered', tool, answer: option?.label ?? null }
  }
}
