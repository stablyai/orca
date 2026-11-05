import type { AgentSessionUsageLimit } from './agent-session/failures/agent-session-usage-limit'
import {
  codexUsageLimit,
  type CodexUsageLimitSnapshot
} from './agent-session/failures/provider-usage-limit'
import { record, type JsonRecord } from './codex-rollout-jsonl-cursor'

export type CodexTerminalUsageLimitTurn = {
  turnId?: string
  rateLimits?: CodexUsageLimitSnapshot
  usageLimit?: AgentSessionUsageLimit
}

function rawWindow(value: unknown): CodexUsageLimitSnapshot['primary'] {
  const window = record(value)
  return window
    ? {
        usedPercent: window.used_percent,
        windowDurationMins: window.window_minutes,
        resetsAt: window.resets_at
      }
    : null
}

/** Keep quota evidence on the root turn that observed it, never on an account percentage alone. */
export function reconcileCodexTerminalUsageLimit(
  turn: CodexTerminalUsageLimitTurn,
  records: readonly JsonRecord[],
  now = Date.now()
): void {
  for (const item of records) {
    if (item.type !== 'event_msg') {
      continue
    }
    const payload = record(item.payload)
    if (!payload) {
      continue
    }
    if (payload.type === 'task_started' || payload.type === 'turn_started') {
      const attribution = record(payload.turn_attribution)
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined
      turn.turnId =
        attribution?.parent_turn_id != null ||
        (payload.root_turn_id != null && payload.root_turn_id !== turnId)
          ? undefined
          : turnId
      turn.rateLimits = undefined
      turn.usageLimit = undefined
      continue
    }
    if (!turn.turnId) {
      continue
    }
    if (payload.type === 'token_count') {
      const limits = record(payload.rate_limits)
      if (limits && limits.limit_id != null && limits.limit_id !== 'codex') {
        turn.rateLimits = undefined
      }
      if (limits && (limits.limit_id == null || limits.limit_id === 'codex')) {
        turn.rateLimits = {
          primary: rawWindow(limits.primary),
          secondary: rawWindow(limits.secondary),
          planType: limits.plan_type,
          rateLimitReachedType: limits.rate_limit_reached_type
        }
      }
    } else if (
      payload.turn_id === turn.turnId &&
      (payload.type === 'task_complete' || payload.type === 'turn_complete')
    ) {
      turn.usageLimit =
        record(payload.error)?.codex_error_info === 'usage_limit_exceeded'
          ? (codexUsageLimit(turn.rateLimits ?? {}, now) ?? {})
          : undefined
    } else if (payload.type === 'turn_aborted' && payload.turn_id === turn.turnId) {
      turn.usageLimit = undefined
    }
  }
}
