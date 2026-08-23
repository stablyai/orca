// The subagent roster carried on a status entry: a provider session's in-process children, which
// have no PTY of their own. Separate from `agent-status-types` so the entry's own shape and this
// roster can each grow without the two colliding in one file.

export type AgentSubagentState = 'working' | 'blocked' | 'waiting' | 'idle'

/** A live in-process child of the pane's provider session. Rendered as an
 *  indented child row with no PTY of its own. */
export type AgentSubagentSnapshot = {
  /** Provider-assigned lifecycle id. */
  id: string
  agentType?: string
  /** Provider model used by this child, when exposed by its lifecycle event. */
  model?: string
  description?: string
  state: AgentSubagentState
  /** Timestamp (ms) when this subagent was first observed. */
  startedAt: number
}

/** Maximum subagent child rows carried per status entry. Bounds per-pane cache
 *  and IPC fanout against a runaway spawner. */
export const AGENT_STATUS_MAX_SUBAGENTS = 32

/** Structural equality for subagent lists so stores can reuse the previous
 *  array reference (and skip fanout) when nothing actually changed. */
export function agentSubagentsEqual(
  a: AgentSubagentSnapshot[] | undefined,
  b: AgentSubagentSnapshot[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a && !b
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.startedAt !== y.startedAt ||
      x.agentType !== y.agentType ||
      x.model !== y.model ||
      x.description !== y.description
    ) {
      return false
    }
  }
  return true
}
