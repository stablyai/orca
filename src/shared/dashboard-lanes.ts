import type { DashboardBucket } from './dashboard-snapshot'

/**
 * User-defined Agent Dashboard lanes ("Waiting", "Blocked on review", …).
 *
 * Built-in columns are derived from live agent state; a custom lane is a
 * manual parking spot. A card the user drags into one stays there until they
 * drag it back out — with one exception: an agent that asks for input still
 * surfaces in Needs You, because a parked card must never hide a question.
 */
export type DashboardCustomLane = {
  id: string
  label: string
}

/** Persisted lane state. Both keys live in global settings so the in-window
 *  board, the pop-out and a restarted app all read the same placement. */
export type DashboardLaneSettings = {
  agentDashboardCustomLanes?: DashboardCustomLane[]
  /** paneKey → custom lane id. */
  agentDashboardLaneByPaneKey?: Record<string, string>
}

export type DashboardLaneAction =
  | { kind: 'add'; label: string }
  | { kind: 'rename'; laneId: string; label: string }
  | { kind: 'remove'; laneId: string }
  /** `laneId: null` returns the card to its automatic status column. */
  | { kind: 'place'; paneKey: string; laneId: string | null }

export const DASHBOARD_MAX_CUSTOM_LANES = 8
export const DASHBOARD_MAX_LANE_LABEL_LENGTH = 40
export const DASHBOARD_MAX_LANE_PLACEMENTS = 500

export function normalizeDashboardLaneLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, DASHBOARD_MAX_LANE_LABEL_LENGTH)
}

/** The lane a card renders in, or undefined for its automatic status column. */
export function resolveDashboardCardLaneId(
  lanes: readonly DashboardCustomLane[] | undefined,
  laneByPaneKey: Readonly<Record<string, string>> | undefined,
  paneKey: string,
  bucket: DashboardBucket
): string | undefined {
  const laneId = laneByPaneKey?.[paneKey]
  if (!laneId || bucket === 'attention') {
    return undefined
  }
  return lanes?.some((lane) => lane.id === laneId) ? laneId : undefined
}

type ApplyOptions = {
  newLaneId: () => string
  /** Placements for panes that no longer exist are dropped on write so the
   *  map cannot grow without bound across months of closed tabs. */
  isLivePaneKey: (paneKey: string) => boolean
}

/**
 * Apply one lane action to the persisted state. Returns the settings patch to
 * write, or null when the action is a no-op (unknown lane, empty label, …).
 */
export function applyDashboardLaneAction(
  current: DashboardLaneSettings,
  action: DashboardLaneAction,
  options: ApplyOptions
): Required<DashboardLaneSettings> | null {
  const lanes = current.agentDashboardCustomLanes ?? []
  const placements = current.agentDashboardLaneByPaneKey ?? {}
  const hasLane = (laneId: string): boolean => lanes.some((lane) => lane.id === laneId)

  switch (action.kind) {
    case 'add': {
      const label = normalizeDashboardLaneLabel(action.label)
      if (!label || lanes.length >= DASHBOARD_MAX_CUSTOM_LANES) {
        return null
      }
      return {
        agentDashboardCustomLanes: [...lanes, { id: options.newLaneId(), label }],
        agentDashboardLaneByPaneKey: placements
      }
    }
    case 'rename': {
      const label = normalizeDashboardLaneLabel(action.label)
      if (!label || !hasLane(action.laneId)) {
        return null
      }
      return {
        agentDashboardCustomLanes: lanes.map((lane) =>
          lane.id === action.laneId ? { ...lane, label } : lane
        ),
        agentDashboardLaneByPaneKey: placements
      }
    }
    case 'remove': {
      if (!hasLane(action.laneId)) {
        return null
      }
      // Cards in a removed lane fall back to their automatic column.
      const kept = Object.fromEntries(
        Object.entries(placements).filter(([, laneId]) => laneId !== action.laneId)
      )
      return {
        agentDashboardCustomLanes: lanes.filter((lane) => lane.id !== action.laneId),
        agentDashboardLaneByPaneKey: kept
      }
    }
    case 'place': {
      if (action.laneId !== null && !hasLane(action.laneId)) {
        return null
      }
      if ((placements[action.paneKey] ?? null) === action.laneId) {
        return null
      }
      const next: Record<string, string> = {}
      for (const [paneKey, laneId] of Object.entries(placements)) {
        if (paneKey !== action.paneKey && hasLane(laneId) && options.isLivePaneKey(paneKey)) {
          next[paneKey] = laneId
        }
      }
      if (action.laneId !== null) {
        next[action.paneKey] = action.laneId
      }
      // Insertion order is placement order, so the oldest placements go first.
      const entries = Object.entries(next)
      return {
        agentDashboardCustomLanes: lanes,
        agentDashboardLaneByPaneKey: Object.fromEntries(
          entries.slice(Math.max(0, entries.length - DASHBOARD_MAX_LANE_PLACEMENTS))
        )
      }
    }
  }
}
