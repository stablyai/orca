import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import type {
  WorkerApprovalDecision,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { Translate } from '@/i18n/use-translate'
import { normalizeToolInput } from '../../../../../shared/native-chat/tools/native-chat-tool-summary'

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

/** The whole command when the detail is a tool call's input; any other detail as it is. */
function approvalDetailCommand(detail: string | null): string | null {
  const input = detail === null ? null : normalizeToolInput(detail)
  const command =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (Reflect.get(input, 'command') ?? Reflect.get(input, 'cmd'))
      : null
  return typeof command === 'string' && command.trim() ? command : detail
}

/** A closed approval as the answered-prompt row reads it. */
export function workerApprovalReceiptBody(
  approval: WorkerApprovalPayload,
  at: string,
  t: Translate
): AgentJournalApprovalItem {
  const decision = approval.outcome?.decision ?? null
  return {
    kind: 'approval',
    title: approval.summary.title,
    // A tool call's input reads as its command, as the agent's own tool rows show it.
    detail: approvalDetailCommand(approval.summary.detail),
    options: [
      { id: 'allow', label: t('components.native-chat.approval.allow', 'Allow') },
      { id: 'deny', label: t('components.native-chat.approval.deny', 'Deny') }
    ],
    resolution: {
      state: decision ? 'resolved' : 'cancelled',
      selectedOptionId: decision,
      resolvedBy: null,
      resolvedAt: Date.parse(at)
    }
  }
}

/** Who answered, from the closing message's evidence; a close it does not name says only that. */
export function workerApprovalReceiptText(approval: WorkerApprovalPayload, t: Translate): string {
  const outcome = approval.outcome
  const decision = outcome?.decision ?? null
  const by = outcome?.by
  switch (decision === null && by !== 'terminal-only' && by !== 'worker-ended' ? 'unknown' : by) {
    case 'person':
      return decision === 'allow'
        ? t('components.native-chat.approval.allowedByYou', 'Allowed by you')
        : t('components.native-chat.approval.deniedByYou', 'Denied by you')
    case 'coordinator':
      return decision === 'allow'
        ? t(
            'components.native-chat.approval.allowedByCoordinator',
            'Allowed by coordinator: {{reason}}',
            {
              reason: outcome?.reason ?? ''
            }
          )
        : t('components.native-chat.approval.deniedByCoordinator', 'Denied by coordinator')
    case 'worker-terminal':
      return decision === 'allow'
        ? t('components.native-chat.approval.allowedInTerminal', "Allowed in the worker's terminal")
        : t('components.native-chat.approval.deniedInTerminal', "Denied in the worker's terminal")
    case 'worker-chat':
      return t('components.native-chat.approval.answeredInChat', "Answered in the worker's chat")
    case 'auto':
      return t('components.native-chat.approval.autoDenied', 'Auto-denied by Claude after 2:00')
    case 'terminal-only':
      return t(
        'components.native-chat.approval.answerInTerminal',
        "Answer it in the worker's terminal"
      )
    case 'worker-ended':
      return t('components.native-chat.approval.workerEnded', 'No longer open · worker ended')
    case 'unknown':
    case undefined:
      return t('components.native-chat.approval.closedUnnamed', 'Closed without a recorded answer')
  }
}

/** The coordinator's deny reason, labelled by how it reached the worker: with the denial, or as a
 *  separate message. An allow's reason is in its receipt line. */
export function workerApprovalReceiptReason(
  approval: WorkerApprovalPayload,
  t: Translate
): { reason?: { label: string; text: string } } {
  const outcome = approval.outcome
  if (outcome?.by !== 'coordinator' || outcome.decision !== 'deny' || !outcome.reason) {
    return {}
  }
  return {
    reason: {
      label: outcome.reasonDelivered
        ? t('components.native-chat.approval.reason', 'Reason')
        : t('components.native-chat.approval.reasonSentAsMessage', 'Reason, sent as a message'),
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
