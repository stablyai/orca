import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../execution-host/execution-host'
import { structuredAgentSessionIdOfTab } from '../agent-session/view/structured-agent-session-tab'
import { parsePaneKey } from '../workspace-layout/stable-pane-id'
import type { AgentStatusIpcPayload } from '../agent-status/contracts/agent-status-ipc-payload'
import { isFreshNonDoneAgentStatus } from '../agent-status/contracts/agent-status-freshness'
import type { AgentStatusState } from '../agent-status/contracts/agent-status-types'

/** The three glyph lanes the bar renders. Mirrors the dashboard's buckets, minus `idle`. */
export type NotchLane = 'working' | 'attention' | 'done'

export const NOTCH_LANES: readonly NotchLane[] = ['working', 'attention', 'done'] as const

export type NotchStatusObservation = AgentStatusIpcPayload & {
  executionHostId?: ExecutionHostId
  sessionId?: string
  title?: string
  leafId?: string | null
  originalPaneKey?: string
  structuredHostOwned?: true
  mirroredEvidenceReceivedAt?: number
  completionIdentity?: string
}

export type NotchSession = {
  paneKey: string
  executionHostId: ExecutionHostId
  sessionId: string | null
  title?: string
  leafId: string | null
  originalPaneKey: string
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
  snapshot: readonly NotchStatusObservation[]
  /** paneKey -> ack timestamp, mirrored into main from the renderer's acknowledgeAgents. */
  acknowledgedAtByPaneKey: Readonly<Record<string, number>>
  acknowledgedCompletions?: Readonly<Record<string, string>>
  /** Injected so the decay below is testable and so one tick sees one consistent clock. */
  now?: number
}

export function buildNotchSummary({
  snapshot,
  acknowledgedAtByPaneKey,
  acknowledgedCompletions = {},
  now = Date.now()
}: BuildNotchSummaryArgs): NotchStatusSummary {
  const counts: Record<NotchLane, number> = { working: 0, attention: 0, done: 0 }
  const sessions: NotchSession[] = []
  const seen = new Set<string>()

  for (const entry of snapshot) {
    if (entry.providerSessionOnly) {
      continue
    }
    if (entry.state === 'done' && entry.sessionBoundary === true) {
      continue
    }
    // Snapshots are keyed by pane upstream, but a duplicate would double-count silently.
    if (seen.has(entry.paneKey)) {
      continue
    }
    seen.add(entry.paneKey)

    if (
      !isFreshNonDoneAgentStatus(
        {
          state: entry.state,
          updatedAt: entry.evidenceObservedAt ?? entry.receivedAt,
          restoredUnconfirmed: entry.restoredUnconfirmed,
          structuredHostOwned:
            entry.structuredHostOwned ?? (entry.structuredHost === 'owned' ? true : undefined),
          mirroredEvidenceReceivedAt: entry.mirroredEvidenceReceivedAt
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
      (entry.completionIdentity
        ? acknowledgedCompletions[entry.paneKey] === entry.completionIdentity
        : !isUnvisited(entry.stateStartedAt, acknowledgedAtByPaneKey[entry.paneKey]))
    ) {
      continue
    }

    counts[lane] += 1
    sessions.push({
      paneKey: entry.paneKey,
      executionHostId: entry.executionHostId ?? getConnectionExecutionHostId(entry.connectionId),
      sessionId:
        entry.sessionId ??
        (entry.structuredHost && entry.tabId ? structuredAgentSessionIdOfTab(entry.tabId) : null),
      title: entry.title,
      leafId: entry.leafId ?? parsePaneKey(entry.originalPaneKey ?? entry.paneKey)?.leafId ?? null,
      originalPaneKey: entry.originalPaneKey ?? entry.paneKey,
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
