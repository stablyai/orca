import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat-turn-activity'

export const NATIVE_CHAT_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'complete',
  'usageLimited',
  'budgetLimited'
] as const

export type NativeChatGoalStatus = (typeof NATIVE_CHAT_GOAL_STATUSES)[number]

export type NativeChatGoal = {
  objective: string
  status: NativeChatGoalStatus
  updatedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePayload(head: string, truncated: boolean): Record<string, unknown> | null {
  if (truncated) {
    return null
  }
  try {
    const value: unknown = JSON.parse(head)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function goalStatus(value: unknown): NativeChatGoalStatus | null {
  return NATIVE_CHAT_GOAL_STATUSES.find((status) => status === value) ?? null
}

function timestampMilliseconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value
}

/** Latest provider-confirmed Codex goal. A clear frame removes the persistent strip. */
export function selectNativeChatGoal(
  items: readonly AgentJournalRenderItem[]
): NativeChatGoal | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const frame = item?.body.kind === 'status' ? item.body.providerFrame : undefined
    if (frame?.provider !== 'codex') {
      continue
    }
    const method = frame.kind.replace(/^notification:/, '')
    if (method === 'thread/goal/cleared') {
      return null
    }
    if (method !== 'thread/goal/updated') {
      continue
    }
    const payload = parsePayload(frame.payload.head, frame.payload.truncated)
    const goal = payload?.goal
    if (!isRecord(goal)) {
      return null
    }
    const objective = typeof goal.objective === 'string' ? goal.objective.trim() : ''
    const status = goalStatus(goal.status)
    if (!objective || !status) {
      return null
    }
    return {
      objective,
      status,
      updatedAt: timestampMilliseconds(goal.updatedAt, item.observedAt)
    }
  }
  return null
}

export function isNativeChatCompacting(activity: NativeChatTurnActivity | null): boolean {
  return activity?.kind === 'description' && activity.text === 'Compacting the conversation'
}
