// Derives the notch bar's per-lane counts and session list from an agent-status snapshot.
// Electron-free on purpose: main owns the data, but the math runs (and is tested) anywhere.
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusIpcPayload,
  type AgentStatusState
} from '../agent-status-types'

/** The three glyph lanes the bar renders. Mirrors the dashboard's buckets, minus `idle`. */
export type NotchLane = 'working' | 'attention' | 'done'

export const NOTCH_LANES: readonly NotchLane[] = ['working', 'attention', 'done'] as const

export type NotchSession = {
  paneKey: string
  lane: NotchLane
  state: AgentStatusState
  agentType?: string
  worktreeId?: string
  tabId?: string
  /** Drives the elapsed-time column; when the current state began, not last ping. */
  stateStartedAt: number
  /** Null for local panes, set for SSH-ingested ones. */
  connectionId: string | null
}

export type NotchStatusSummary = {
  counts: Record<NotchLane, number>
  sessions: NotchSession[]
}

export const EMPTY_NOTCH_SUMMARY: NotchStatusSummary = {
  counts: { working: 0, attention: 0, done: 0 },
  sessions: []
}

/**
 * Why: must stay identical to `bucketForState` in
 * renderer/src/components/dashboard/build-dashboard-snapshot.ts — if these drift, the notch
 * and the dashboard report different numbers for the same agents.
 */
export function laneForState(state: AgentStatusState): NotchLane {
  switch (state) {
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    // blocked | waiting — the agent needs the user.
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

/**
 * Why: reuses Orca's existing unvisited rule (`ackAt < stateStartedAt`, see
 * hooks/useAutoAckViewedAgent.ts) rather than a retention timer, so a finished agent stops
 * counting green the moment you look at its pane — and never before.
 */
export function isUnvisited(stateStartedAt: number, acknowledgedAt: number | undefined): boolean {
  return (acknowledgedAt ?? 0) < stateStartedAt
}

// Attention outranks working outranks done, so the row needing you is never scrolled away.
const LANE_ORDER: Record<NotchLane, number> = { attention: 0, working: 1, done: 2 }

function compareSessions(a: NotchSession, b: NotchSession): number {
  const byLane = LANE_ORDER[a.lane] - LANE_ORDER[b.lane]
  if (byLane !== 0) {
    return byLane
  }
  const byRecency = b.stateStartedAt - a.stateStartedAt
  // paneKey breaks ties so equal timestamps can't reorder rows between ticks.
  return byRecency !== 0 ? byRecency : a.paneKey.localeCompare(b.paneKey)
}

export type BuildNotchSummaryArgs = {
  snapshot: readonly AgentStatusIpcPayload[]
  /** paneKey -> ack timestamp, mirrored into main from the renderer's acknowledgeAgents. */
  acknowledgedAtByPaneKey: Readonly<Record<string, number>>
  /** Injected so the decay below is testable and so one tick sees one consistent clock. */
  now?: number
}

/**
 * Recomputes the whole summary from scratch each tick.
 * Why: removals arrive on a separate channel from updates, so a full recompute makes a
 * disappearance a trigger rather than a payload — the two can never disagree.
 */
export function buildNotchSummary({
  snapshot,
  acknowledgedAtByPaneKey,
  now = Date.now()
}: BuildNotchSummaryArgs): NotchStatusSummary {
  const counts: Record<NotchLane, number> = { working: 0, attention: 0, done: 0 }
  const sessions: NotchSession[] = []
  const seen = new Set<string>()

  for (const entry of snapshot) {
    // Why: a resume-identity update carries placeholder status fields; counting it would
    // invent a session that isn't running.
    if (entry.providerSessionOnly) {
      continue
    }
    // A session-boundary `done` (connect/resume/clear landing idle, STA-3386) is not a
    // completed turn; the unvisited-gated green lane is exactly the unread-completion
    // surface that contract says must ignore it.
    if (entry.state === 'done' && entry.sessionBoundary === true) {
      continue
    }
    // Snapshots are keyed by pane upstream, but a duplicate would double-count silently.
    if (seen.has(entry.paneKey)) {
      continue
    }
    seen.add(entry.paneKey)

    // Why: a SIGKILLed agent never sends `done`, and hydrateLastStatusFromDisk restores entries
    // up to a week old with their state untouched — so without this the bar reports phantom
    // working agents, including straight after a cold start. The sidebar and dashboard already
    // decay the same map through isFreshNonDoneAgentStatus; sharing it is what keeps the notch
    // and the dashboard from reporting different numbers for the same agents.
    if (
      !isFreshNonDoneAgentStatus(
        {
          state: entry.state,
          updatedAt: entry.receivedAt,
          restoredUnconfirmed: entry.restoredUnconfirmed
        },
        now
      )
    ) {
      // `done` is exempt: it is a terminal state, not a heartbeat, and stays until acknowledged.
      if (entry.state !== 'done') {
        continue
      }
    }

    const lane = laneForState(entry.state)
    // A finished agent you've already looked at leaves the bar entirely — bar and panel agree.
    if (
      lane === 'done' &&
      !isUnvisited(entry.stateStartedAt, acknowledgedAtByPaneKey[entry.paneKey])
    ) {
      continue
    }

    counts[lane] += 1
    sessions.push({
      paneKey: entry.paneKey,
      lane,
      state: entry.state,
      agentType: entry.agentType,
      worktreeId: entry.worktreeId,
      tabId: entry.tabId,
      stateStartedAt: entry.stateStartedAt,
      connectionId: entry.connectionId
    })
  }

  sessions.sort(compareSessions)
  return { counts, sessions }
}

/** True when the bar should collapse to its dimmed resting glyph. */
export function isNotchIdle(summary: NotchStatusSummary): boolean {
  return summary.counts.working === 0 && summary.counts.attention === 0 && summary.counts.done === 0
}
