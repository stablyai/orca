import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

export type AgentMapTimeField = 'lifespan' | 'sinceMessage' | 'timeInState'
/** Inclusive stop indices into `AGENT_MAP_TIME_STOPS`. */
export type AgentMapTimeRange = { min: number; max: number }
export type AgentMapTimeRanges = Record<AgentMapTimeField, AgentMapTimeRange>

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Non-linear stops: minutes matter as much as days, so a linear axis would
 *  bury every useful threshold in the first pixel. */
export const AGENT_MAP_TIME_STOPS: readonly number[] = [
  0,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  3 * DAY,
  7 * DAY,
  14 * DAY,
  Number.POSITIVE_INFINITY
]

export const AGENT_MAP_TIME_MAX_INDEX = AGENT_MAP_TIME_STOPS.length - 1
export const AGENT_MAP_TIME_FIELDS: readonly AgentMapTimeField[] = [
  'lifespan',
  'sinceMessage',
  'timeInState'
]

export const FULL_AGENT_MAP_TIME_RANGE: AgentMapTimeRange = {
  min: 0,
  max: AGENT_MAP_TIME_MAX_INDEX
}

export function fullAgentMapTimeRanges(): AgentMapTimeRanges {
  return {
    lifespan: { ...FULL_AGENT_MAP_TIME_RANGE },
    sinceMessage: { ...FULL_AGENT_MAP_TIME_RANGE },
    timeInState: { ...FULL_AGENT_MAP_TIME_RANGE }
  }
}

export function isFullAgentMapTimeRange(range: AgentMapTimeRange): boolean {
  return range.min <= 0 && range.max >= AGENT_MAP_TIME_MAX_INDEX
}

export function agentMapTimeStopLabel(index: number): string {
  const ms = AGENT_MAP_TIME_STOPS[Math.min(Math.max(index, 0), AGENT_MAP_TIME_MAX_INDEX)]
  if (!Number.isFinite(ms)) {
    return '∞'
  }
  if (ms === 0) {
    return '0'
  }
  if (ms < HOUR) {
    return `${Math.round(ms / MINUTE)}m`
  }
  if (ms < DAY) {
    return `${Math.round(ms / HOUR)}h`
  }
  return `${Math.round(ms / DAY)}d`
}

/** How long the agent has been alive, quiet, and sitting in its current state. */
export function agentMapDurations(
  card: DashboardCard,
  now: number
): Record<AgentMapTimeField, number> {
  const startedAt = validTimestamp(card.startedAt) ? card.startedAt : null
  const enteredState = validTimestamp(card.stateChangedAt) ? card.stateChangedAt : startedAt
  const lastMessage = validTimestamp(card.statusUpdatedAt) ? card.statusUpdatedAt : enteredState
  const finishedAt = validTimestamp(card.finishedAt) ? card.finishedAt : null
  return {
    lifespan: startedAt === null ? 0 : Math.max(0, (finishedAt ?? now) - startedAt),
    // No per-message timestamp rides the snapshot; the last accepted hook update
    // is the closest thing to "when this agent last said something".
    sinceMessage: lastMessage === null ? 0 : Math.max(0, now - lastMessage),
    timeInState: enteredState === null ? 0 : Math.max(0, now - enteredState)
  }
}

function validTimestamp(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function withinRange(value: number, range: AgentMapTimeRange): boolean {
  if (value < AGENT_MAP_TIME_STOPS[Math.max(0, range.min)]) {
    return false
  }
  return range.max >= AGENT_MAP_TIME_MAX_INDEX || value <= AGENT_MAP_TIME_STOPS[range.max]
}

export function matchesAgentMapTimeRanges(
  card: DashboardCard,
  ranges: AgentMapTimeRanges,
  now: number
): boolean {
  const durations = agentMapDurations(card, now)
  return AGENT_MAP_TIME_FIELDS.every((field) => withinRange(durations[field], ranges[field]))
}

export function activeAgentMapTimeFields(ranges: AgentMapTimeRanges): AgentMapTimeField[] {
  return AGENT_MAP_TIME_FIELDS.filter((field) => !isFullAgentMapTimeRange(ranges[field]))
}
