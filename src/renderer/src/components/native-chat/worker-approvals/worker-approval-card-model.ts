import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import type {
  WorkerApprovalDecision,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { Translate } from '@/i18n/use-translate'
import {
  workerApprovalRecord,
  type WorkerApprovalRecordSentence
} from '../../../../../shared/orchestration/approvals/worker-approval-record'
import {
  approvalRecordDetail,
  type NativeChatApprovalRecordLine
} from '../prompts/native-chat-approval-record'

/** The card a worker's open approval shows: its own words, and only the answers Orca can give. */
export function workerApprovalCard(approval: WorkerApprovalPayload, t: Translate): ChatApproval {
  const { title, detail, reason } = approval.summary
  return {
    title,
    ...(reason ? { decisionReason: reason } : {}),
    ...(detail ? { detail } : {}),
    options: approval.allowedActions.map((decision) => ({
      label:
        decision === 'allow'
          ? t('components.native-chat.approval.allow', 'Allow')
          : t('components.native-chat.approval.deny', 'Deny'),
      send: decision
    }))
  }
}

export function isWorkerApprovalDecision(value: string): value is WorkerApprovalDecision {
  return value === 'allow' || value === 'deny'
}

const RECORD_SENTENCES: Record<WorkerApprovalRecordSentence, (t: Translate) => string> = {
  youAllowedFor: (t) =>
    t(
      'components.native-chat.approval.record.youAllowedFor',
      'You allowed <tool>{{tool}}</tool> for <task>{{task}}</task>'
    ),
  youDeniedFor: (t) =>
    t(
      'components.native-chat.approval.record.youDeniedFor',
      'You denied <tool>{{tool}}</tool> for <task>{{task}}</task>'
    ),
  coordinatorAllowed: (t) =>
    t(
      'components.native-chat.approval.record.coordinatorAllowed',
      'Coordinator allowed <tool>{{tool}}</tool> for <task>{{task}}</task>'
    ),
  coordinatorDenied: (t) =>
    t(
      'components.native-chat.approval.record.coordinatorDenied',
      'Coordinator denied <tool>{{tool}}</tool> for <task>{{task}}</task>'
    ),
  allowedInTerminal: (t) =>
    t(
      'components.native-chat.approval.record.allowedInTerminal',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> allowed in its terminal'
    ),
  deniedInTerminal: (t) =>
    t(
      'components.native-chat.approval.record.deniedInTerminal',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> denied in its terminal'
    ),
  allowedInChat: (t) =>
    t(
      'components.native-chat.approval.record.allowedInChat',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> allowed in its chat'
    ),
  deniedInChat: (t) =>
    t(
      'components.native-chat.approval.record.deniedInChat',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> denied in its chat'
    ),
  autoDenied: (t) =>
    t(
      'components.native-chat.approval.record.autoDenied',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> denied automatically after 2:00'
    ),
  waitsInTerminal: (t) =>
    t(
      'components.native-chat.approval.record.waitsInTerminal',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> waits in its terminal'
    ),
  workerEnded: (t) =>
    t(
      'components.native-chat.approval.record.workerEnded',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> closed: the worker ended'
    ),
  closedUnnamed: (t) =>
    t(
      'components.native-chat.approval.record.closedUnnamed',
      '<tool>{{tool}}</tool> for <task>{{task}}</task> closed without a recorded answer'
    )
}

/** A closed worker prompt as its one-line record: who answered and how, naming the tool and the
 *  worker's task; the command and any coordinator reason open under it. */
export function workerApprovalRecordLine(
  approval: WorkerApprovalPayload,
  task: string,
  at: string,
  t: Translate
): NativeChatApprovalRecordLine {
  const { tone, sentence, tool, opensWorker, reason } = workerApprovalRecord(approval)
  return {
    tone,
    sentence: RECORD_SENTENCES[sentence](t),
    values: { tool, task },
    detail: approvalRecordDetail(approval.summary.detail),
    at: Date.parse(at),
    ...(opensWorker ? { opensWorker } : {}),
    // Labelled by how it reached the worker: with its answer, or as a separate message.
    ...(reason
      ? {
          reason: {
            label: reason.sentAsMessage
              ? t(
                  'components.native-chat.approval.reasonSentAsMessage',
                  'Reason, sent as a message'
                )
              : t(
                  'components.native-chat.approval.record.coordinatorReason',
                  "Coordinator's reason"
                ),
            text: reason.text
          }
        }
      : {})
  }
}

// Why 15 s: the agent's own timeout sends its closing message within moments of the countdown.
const LAPSE_GRACE_MS = 15_000

/** When an open card stops being shown: its agent decided on its own and no closing message came,
 *  as when the app restarted while the prompt was open. Never for a closed one or one with no countdown. */
export function workerApprovalLapsesAt(approval: WorkerApprovalPayload): number {
  const expiresAt =
    approval.state === 'open' && approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN
  return Number.isFinite(expiresAt) ? expiresAt + LAPSE_GRACE_MS : Number.POSITIVE_INFINITY
}
