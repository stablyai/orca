import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import type {
  WorkerApprovalDecision,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { Translate } from '@/i18n/use-translate'
import {
  approvalRecordDetail,
  approvalRecordTool,
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

/** A closed worker prompt as its one-line record: who answered and how, naming the tool and the
 *  worker's task; the command and any coordinator reason open under it. */
export function workerApprovalRecordLine(
  approval: WorkerApprovalPayload,
  task: string,
  at: string,
  t: Translate
): NativeChatApprovalRecordLine {
  const outcome = approval.outcome
  const decision = outcome?.decision ?? null
  const by = outcome?.by
  const values = { tool: approvalRecordTool(approval.summary.tool, approval.summary.title), task }
  const base = {
    values,
    detail: approvalRecordDetail(approval.summary.detail),
    at: Date.parse(at),
    ...workerApprovalRecordReason(approval, t)
  }
  const tone = decision === 'allow' ? 'allowed' : 'denied'
  switch (decision === null && by !== 'terminal-only' && by !== 'worker-ended' ? 'unknown' : by) {
    case 'person':
      return {
        ...base,
        tone,
        sentence:
          decision === 'allow'
            ? t(
                'components.native-chat.approval.record.youAllowedFor',
                'You allowed <tool>{{tool}}</tool> for <task>{{task}}</task>'
              )
            : t(
                'components.native-chat.approval.record.youDeniedFor',
                'You denied <tool>{{tool}}</tool> for <task>{{task}}</task>'
              )
      }
    case 'coordinator':
      return {
        ...base,
        tone,
        sentence:
          decision === 'allow'
            ? t(
                'components.native-chat.approval.record.coordinatorAllowed',
                'Coordinator allowed <tool>{{tool}}</tool> for <task>{{task}}</task>'
              )
            : t(
                'components.native-chat.approval.record.coordinatorDenied',
                'Coordinator denied <tool>{{tool}}</tool> for <task>{{task}}</task>'
              )
      }
    case 'worker-terminal':
      return {
        ...base,
        tone,
        sentence:
          decision === 'allow'
            ? t(
                'components.native-chat.approval.record.allowedInTerminal',
                '<tool>{{tool}}</tool> for <task>{{task}}</task> allowed in its terminal'
              )
            : t(
                'components.native-chat.approval.record.deniedInTerminal',
                '<tool>{{tool}}</tool> for <task>{{task}}</task> denied in its terminal'
              )
      }
    case 'worker-chat':
      return {
        ...base,
        tone,
        sentence:
          decision === 'allow'
            ? t(
                'components.native-chat.approval.record.allowedInChat',
                '<tool>{{tool}}</tool> for <task>{{task}}</task> allowed in its chat'
              )
            : t(
                'components.native-chat.approval.record.deniedInChat',
                '<tool>{{tool}}</tool> for <task>{{task}}</task> denied in its chat'
              )
      }
    case 'auto':
      return {
        ...base,
        tone: 'denied',
        sentence: t(
          'components.native-chat.approval.record.autoDenied',
          '<tool>{{tool}}</tool> for <task>{{task}}</task> denied automatically after 2:00'
        )
      }
    case 'terminal-only':
      return {
        ...base,
        tone: 'open',
        opensWorker: true,
        sentence: t(
          'components.native-chat.approval.record.waitsInTerminal',
          '<tool>{{tool}}</tool> for <task>{{task}}</task> waits in its terminal'
        )
      }
    case 'worker-ended':
      return {
        ...base,
        tone: 'closed',
        sentence: t(
          'components.native-chat.approval.record.workerEnded',
          '<tool>{{tool}}</tool> for <task>{{task}}</task> closed: the worker ended'
        )
      }
    case 'unknown':
    case undefined:
      return {
        ...base,
        tone: 'closed',
        sentence: t(
          'components.native-chat.approval.record.closedUnnamed',
          '<tool>{{tool}}</tool> for <task>{{task}}</task> closed without a recorded answer'
        )
      }
  }
}

/** The coordinator's reason, labelled by how it reached the worker: with its answer, or as a
 *  separate message. */
function workerApprovalRecordReason(
  approval: WorkerApprovalPayload,
  t: Translate
): { reason?: { label: string; text: string } } {
  const outcome = approval.outcome
  if (outcome?.by !== 'coordinator' || !outcome.reason) {
    return {}
  }
  return {
    reason: {
      label:
        outcome.decision === 'deny' && !outcome.reasonDelivered
          ? t('components.native-chat.approval.reasonSentAsMessage', 'Reason, sent as a message')
          : t('components.native-chat.approval.record.coordinatorReason', "Coordinator's reason"),
      text: outcome.reason
    }
  }
}

/** Seconds left before the agent decides on its own, as m:ss; null once past or unknown. */
export function workerApprovalTimeLeft(expiresAt: string | undefined, now: number): string | null {
  const left = expiresAt ? Math.ceil((Date.parse(expiresAt) - now) / 1_000) : Number.NaN
  if (!Number.isFinite(left) || left <= 0) {
    return null
  }
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
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
