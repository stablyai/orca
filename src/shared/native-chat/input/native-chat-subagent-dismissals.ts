import { NATIVE_CHAT_SUBAGENT_STATES, type NativeChatSubagentState } from '../native-chat-types'
import type { NativeChatSubagentActivity } from './native-chat-activity'

/** Failed and unverifiable stay on the sheet until the user dismisses them. */
export const DISMISSIBLE_SUBAGENT_STATES: ReadonlySet<NativeChatSubagentState> = new Set([
  'failed',
  'unverifiable'
])

export type DismissedSubagentStates = Readonly<Record<string, NativeChatSubagentState>>

const MAX_DISMISSED = 200

function isSubagentState(value: unknown): value is NativeChatSubagentState {
  return NATIVE_CHAT_SUBAGENT_STATES.some((state) => state === value)
}

export function nativeChatSubagentDismissible(state: NativeChatSubagentState): boolean {
  return DISMISSIBLE_SUBAGENT_STATES.has(state)
}

export function parseDismissedSubagentStates(raw: unknown): DismissedSubagentStates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const next: Record<string, NativeChatSubagentState> = {}
  for (const [id, state] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length === 0 || id.length > 256 || !isSubagentState(state)) {
      continue
    }
    next[id] = state
    if (Object.keys(next).length >= MAX_DISMISSED) {
      break
    }
  }
  return next
}

export function parseDismissedSubagentStatesJson(raw: string | null): DismissedSubagentStates {
  if (!raw) {
    return {}
  }
  try {
    return parseDismissedSubagentStates(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

/** Hide a child only while it is still in the state the user dismissed. */
export function nativeChatVisibleDismissedSubagents(
  listed: readonly NativeChatSubagentActivity[],
  dismissed: DismissedSubagentStates
): NativeChatSubagentActivity[] {
  return listed.filter((agent) => dismissed[agent.id] !== agent.state)
}

export function nativeChatDismissSubagents(
  dismissed: DismissedSubagentStates,
  agents: readonly NativeChatSubagentActivity[]
): DismissedSubagentStates {
  const next: Record<string, NativeChatSubagentState> = { ...dismissed }
  for (const agent of agents) {
    if (nativeChatSubagentDismissible(agent.state)) {
      next[agent.id] = agent.state
    }
  }
  return next
}

/** A different live state is a new report, so the stored dismissal no longer applies. */
export function nativeChatReconcileDismissals(
  dismissed: DismissedSubagentStates,
  roster: readonly NativeChatSubagentActivity[]
): DismissedSubagentStates {
  const current = new Map(roster.map((agent) => [agent.id, agent.state]))
  let changed = false
  const next: Record<string, NativeChatSubagentState> = {}
  for (const [id, state] of Object.entries(dismissed)) {
    const live = current.get(id)
    if (live !== undefined && live !== state) {
      changed = true
      continue
    }
    next[id] = state
  }
  return changed ? next : dismissed
}
