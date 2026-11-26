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

/** One CLI on one host. */
export function agentCliUpdateRowKey({
  hostKey,
  agent
}: {
  hostKey: string
  agent: AgentCliUpdateAgent
}): string {
  return `${hostKey}\n${agent}`
}

/** Built once per row list, so following a run looks each target up instead of scanning every row. */
export function agentCliUpdateRowsByKey(
  rows: readonly AgentCliUpdateRow[]
): ReadonlyMap<string, AgentCliUpdateRow> {
  return new Map(rows.map((row) => [agentCliUpdateRowKey(row), row]))
}

export function rowFor(
  target: RunTarget,
  rowsByKey: ReadonlyMap<string, AgentCliUpdateRow>
): AgentCliUpdateRow | null {
  return rowsByKey.get(agentCliUpdateRowKey(target)) ?? null
}

// A finished update drops its row from the store, so a missing run means it landed.
export function targetPhase(
  target: RunTarget,
  rowsByKey: ReadonlyMap<string, AgentCliUpdateRow>
): TargetPhase {
  const phase = rowFor(target, rowsByKey)?.run?.phase
  return phase === 'queued' || phase === 'running' || phase === 'failed' ? phase : 'done'
}
