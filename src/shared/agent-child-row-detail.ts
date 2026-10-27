import type { AgentChildWorkKind } from './agent-status-child-work'
import type { AgentChildDisplayState } from './agent-status-child-work-display'

/** What a child row says beside its name. Surfaces format it; they never decide it. */
export type AgentChildRowDetail =
  /** The tool the child is running now, as `tool: input` — the line a CLI agent row shows. */
  | { kind: 'operation'; toolName: string; input?: string }
  /** Its own work is over and only work it owns still runs; the tool line is stale. */
  | { kind: 'monitoring' }
  | { kind: 'message'; text: string }
  /** Settled, and the lane cannot say how. */
  | { kind: 'ended' }
  /** How long since the last evidence for this child (see `recencyAt`). */
  | { kind: 'no-update' }
  /** The child's role, when nothing more specific is known. */
  | { kind: 'role'; agentType: string }
  /** A host that publishes only a run state: that state's reason word. */
  | { kind: 'reason'; state: 'waiting' | 'blocked' | 'unverifiable' }

type AgentChildRowDetailSource = {
  /** `run-state`: the host reported only the child's run state (the legacy task roster). */
  evidence: 'child' | 'run-state'
  kind: AgentChildWorkKind
  name: string
  agentType?: string
  operation?: { toolName: string; input?: string }
  lastMessage?: string
  settled: boolean
}

// A default role or one that restates the name adds nothing.
function roleDetail(source: AgentChildRowDetailSource): AgentChildRowDetail | null {
  if (source.kind !== 'agent') {
    return null
  }
  const agentType = source.agentType ?? 'unknown'
  return agentType.trim() === 'default' || source.name.trim() === agentType.trim()
    ? null
    : { kind: 'role', agentType }
}

function messageOrRole(source: AgentChildRowDetailSource): AgentChildRowDetail | null {
  const text = source.lastMessage?.trim()
  return text ? { kind: 'message', text } : roleDetail(source)
}

/** The one rule for what a child row says, in the order a CLI agent row decides it. */
export function agentChildRowDetail(
  source: AgentChildRowDetailSource,
  displayState: AgentChildDisplayState
): AgentChildRowDetail | null {
  if (source.evidence === 'run-state') {
    return displayState === 'waiting' ||
      displayState === 'blocked' ||
      displayState === 'unverifiable'
      ? { kind: 'reason', state: displayState }
      : null
  }
  switch (displayState) {
    case 'unverifiable':
      return { kind: 'no-update' }
    case 'monitoring':
      // A shell or monitor names itself; only an agent's own tool line goes stale.
      return source.kind === 'agent' ? { kind: 'monitoring' } : null
    case 'working':
    case 'waiting':
      return source.operation
        ? {
            kind: 'operation',
            toolName: source.operation.toolName,
            ...(source.operation.input !== undefined ? { input: source.operation.input } : {})
          }
        : messageOrRole(source)
    case 'blocked':
    case 'done':
    case 'failed':
      return messageOrRole(source)
    case 'interrupted':
      return roleDetail(source)
    case 'idle':
      return source.settled ? { kind: 'ended' } : roleDetail(source)
  }
}
