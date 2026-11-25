import type { AgentCliUpdateAgent } from '../../../../shared/agent-launch/installation/agent-cli-update'
import type { AgentCliUpdateRow } from '../status-bar/updates/AgentCliUpdateList'

/** One CLI the card started updating, with the versions it showed. */
export type RunTarget = {
  hostKey: string
  /** The host heading the offer showed; null when it showed none. */
  hostLabel: string | null
  agent: AgentCliUpdateAgent
  from: string
  to: string
}
export type TargetPhase = 'queued' | 'running' | 'failed' | 'done'

export function rowFor(
  target: RunTarget,
  rows: readonly AgentCliUpdateRow[]
): AgentCliUpdateRow | null {
  return rows.find((row) => row.hostKey === target.hostKey && row.agent === target.agent) ?? null
}

// A finished update drops its row from the store, so a missing run means it landed.
export function targetPhase(target: RunTarget, rows: readonly AgentCliUpdateRow[]): TargetPhase {
  const phase = rowFor(target, rows)?.run?.phase
  return phase === 'queued' || phase === 'running' || phase === 'failed' ? phase : 'done'
}
