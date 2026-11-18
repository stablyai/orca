// Codex's automatic review of an action, as its `item/autoApprovalReview/completed` notification reports it.
// Codex's own terminal UI shows a denial in the chat and lets the person approve one retry of it.

import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'

export const CODEX_AUTO_REVIEW_COMPLETED_FRAME = 'notification:item/autoApprovalReview/completed'

export type CodexAutoReviewDenial = {
  /** What Codex asked to do, worded as Codex's own UI summarizes it. */
  summary: string
  rationale: string | null
  threadId: string
  /** The review as Codex's `thread/approveGuardianDeniedAction` takes it; null when Orca cannot rebuild it. */
  event: Record<string, unknown> | null
}

const record = (value: unknown): Record<string, unknown> | null => (isRecord(value) ? value : null)
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

// The notification spells fields and enum values in camelCase; Codex's review event in snake_case.
// Terminal input and permission requests carry paths and profiles Codex reads in other shapes, so
// those denials show without the button rather than offer an approval Codex would refuse.
const APPROVABLE_ACTIONS = new Set([
  'command',
  'execve',
  'applyPatch',
  'networkAccess',
  'mcpToolCall'
])
const ENUM_FIELDS = new Set(['type', 'source', 'protocol'])

function reviewAction(action: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof action.type !== 'string' || !APPROVABLE_ACTIONS.has(action.type)) {
    return null
  }
  return Object.fromEntries(
    Object.entries(action).map(([key, value]) => [
      snake(key),
      ENUM_FIELDS.has(key) && typeof value === 'string' ? snake(value) : value
    ])
  )
}

function actionSummary(action: Record<string, unknown>): string | null {
  switch (action.type) {
    case 'command':
      return text(action.command)
    case 'execve': {
      const argv = Array.isArray(action.argv)
        ? action.argv.filter((a) => typeof a === 'string')
        : []
      return argv.length > 0 ? argv.join(' ') : text(action.program)
    }
    case 'writeStdin':
      return `send input to terminal ${String(action.processId ?? '')}`.trim()
    case 'applyPatch': {
      const files = Array.isArray(action.files) ? action.files : []
      return files.length === 1 && typeof files[0] === 'string'
        ? `apply_patch touching ${files[0]}`
        : `apply_patch touching ${files.length} files`
    }
    case 'networkAccess':
      return text(action.target) && `network access to ${text(action.target)}`
    case 'mcpToolCall':
      return `MCP ${String(action.toolName ?? '')} on ${String(action.connectorName ?? action.server ?? '')}`
    case 'requestPermissions': {
      const reason = text(action.reason)
      return reason ? `permission request: ${reason}` : 'permission request'
    }
    default:
      return null
  }
}

/** A denied review from the notification's params; anything else, including approvals, is null. */
export function readCodexAutoReviewDenial(params: unknown): CodexAutoReviewDenial | null {
  const notification = record(params)
  const review = record(notification?.review)
  const action = record(notification?.action)
  const threadId = text(notification?.threadId)
  if (!notification || !review || !action || !threadId || review.status !== 'denied') {
    return null
  }
  // Codex's own warning for this denial is hidden, so an action this build cannot word still shows.
  const summary = actionSummary(action) ?? 'an action'
  const approvable = reviewAction(action)
  const reviewId = text(notification.reviewId)
  const rationale = text(review.rationale)
  return {
    summary,
    rationale,
    threadId,
    event:
      approvable && reviewId
        ? {
            id: reviewId,
            ...(text(notification.targetItemId)
              ? { target_item_id: notification.targetItemId }
              : {}),
            turn_id: text(notification.turnId) ?? '',
            started_at_ms: notification.startedAtMs,
            ...(typeof notification.completedAtMs === 'number'
              ? { completed_at_ms: notification.completedAtMs }
              : {}),
            status: 'denied',
            ...(text(review.riskLevel) ? { risk_level: review.riskLevel } : {}),
            ...(text(review.userAuthorization)
              ? { user_authorization: review.userAuthorization }
              : {}),
            ...(rationale ? { rationale } : {}),
            action: approvable
          }
        : null
  }
}

/** The same denial from a saved row's bounded frame; a clipped frame cannot be rebuilt. */
export function readCodexAutoReviewDenialFrame(
  frame:
    | { provider: string; kind: string; payload: { head?: string; truncated?: boolean } }
    | undefined
): CodexAutoReviewDenial | null {
  if (
    frame?.provider !== 'codex' ||
    frame.kind !== CODEX_AUTO_REVIEW_COMPLETED_FRAME ||
    frame.payload.truncated ||
    typeof frame.payload.head !== 'string'
  ) {
    return null
  }
  try {
    return readCodexAutoReviewDenial(JSON.parse(frame.payload.head))
  } catch {
    return null
  }
}
