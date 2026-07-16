import { AGENT_STATUS_MAX_SUBAGENTS, type AgentSubagentSnapshot } from './agent-status-types'

const CODEX_SUBAGENT_ID_MAX_LENGTH = 64

export type CodexSubagentRoster = Map<string, TrackedCodexSubagent>

type TrackedCodexSubagent = {
  agentType?: string
  startedAt: number
}

export function upsertWorkingCodexSubagent(
  roster: CodexSubagentRoster,
  id: string,
  agentType: string | undefined,
  now: number
): boolean {
  if (id.length === 0 || id.length > CODEX_SUBAGENT_ID_MAX_LENGTH) {
    return false
  }
  const existing = roster.get(id)
  if (existing) {
    existing.agentType = agentType ?? existing.agentType
    return true
  }
  // Why: entries beyond the wire cap could gate the parent while remaining
  // invisible in the sidebar, so reject them instead of tracking hidden work.
  if (roster.size >= AGENT_STATUS_MAX_SUBAGENTS) {
    return false
  }
  roster.set(id, { agentType, startedAt: now })
  return true
}

export function finishCodexSubagent(roster: CodexSubagentRoster, id: string): void {
  roster.delete(id)
}

export function codexRosterHasWorkingSubagent(roster: CodexSubagentRoster | undefined): boolean {
  return roster !== undefined && roster.size > 0
}

export function codexRosterToSnapshots(
  roster: CodexSubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    state: 'working' as const,
    startedAt: tracked.startedAt,
    agentType: tracked.agentType
  }))
  // Why: concurrent child hooks have no stable arrival order; deterministic
  // snapshots let the store reuse an unchanged roster instead of re-rendering.
  snapshots.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return snapshots
}
