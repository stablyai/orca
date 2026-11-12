import type { PersistedUIState } from './persisted-ui-state-types'

export const AGENT_ACTIVITY_READ_STATE_CAPABILITY = 'ui.agent-activity-read-state.v1' as const

export type AgentActivitySubject = {
  paneKey: string
  worktreeId: string
  hostId: string
  latestActivityAt: number
  stateStartedAt: number
}

export type AgentActivityReadState = AgentActivitySubject & { unread: boolean }

export function agentActivitySubjectKey(
  subject: Pick<AgentActivitySubject, 'hostId' | 'worktreeId' | 'paneKey'>
): string {
  return JSON.stringify([subject.hostId, subject.worktreeId, subject.paneKey])
}
type Acknowledgements = Pick<PersistedUIState, 'acknowledgedAgentsByPaneKey'> &
  Partial<Pick<PersistedUIState, 'manuallyUnreadTurnsByPaneKey'>>

export function usableTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function latestAgentTurnTimestamp(entry: {
  stateStartedAt?: number
  stateHistory?: { startedAt?: number }[]
}): number {
  let latest = usableTimestamp(entry.stateStartedAt)
  for (const history of entry.stateHistory ?? []) {
    latest = Math.max(latest, usableTimestamp(history.startedAt))
  }
  return latest
}

export function agentActivityReadState(
  subject: AgentActivitySubject,
  ui: Pick<Acknowledgements, 'acknowledgedAgentsByPaneKey'>
): AgentActivityReadState {
  return {
    ...subject,
    unread: (ui.acknowledgedAgentsByPaneKey?.[subject.paneKey] ?? 0) < subject.latestActivityAt
  }
}

export function changeAgentActivityReadState(
  ui: Acknowledgements,
  subject: AgentActivitySubject,
  read: boolean,
  observedThrough: number
): Required<Acknowledgements> {
  const acknowledgedAgentsByPaneKey = { ...ui.acknowledgedAgentsByPaneKey }
  const manuallyUnreadTurnsByPaneKey = { ...ui.manuallyUnreadTurnsByPaneKey }
  if (read) {
    acknowledgedAgentsByPaneKey[subject.paneKey] = Math.max(
      acknowledgedAgentsByPaneKey[subject.paneKey] ?? 0,
      Math.min(usableTimestamp(observedThrough), subject.latestActivityAt)
    )
    delete manuallyUnreadTurnsByPaneKey[subject.paneKey]
  } else {
    delete acknowledgedAgentsByPaneKey[subject.paneKey]
    manuallyUnreadTurnsByPaneKey[subject.paneKey] = subject.stateStartedAt
  }
  return { acknowledgedAgentsByPaneKey, manuallyUnreadTurnsByPaneKey }
}
