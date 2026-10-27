// Internal fleet evidence makes missing identity/clock explicit union arms; optional IPC fields previously silently lost binding or freshness.
// Runtime resolves identity; wire AgentStatusIpcPayload stays unchanged (L-1, W1-14/RR-W-P1A).

import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import type { AgentStatusState, AgentType } from './agent-status-types'

/** Why a row could not be tied to a terminal. No catch-all member: a new gap needs a name. */
export type FleetEvidenceBindingGap =
  /** The pane no longer resolves to a terminal on this runtime. */
  | 'pane_not_bound'
  /** Without a known incarnation, replay after restart cannot bind to the pane’s replacement terminal. */
  | 'incarnation_unbound'
  /** The observed incarnation exited; reminting cached evidence would give it a replacement worker’s identity. */
  | 'stale_incarnation'

/** Terminal identity as the runtime resolves it at mint time. All three facts or none. */
type FleetBoundTerminal = {
  terminalHandle: string
  paneKey: string
  /** The incarnation the pane runs NOW, compared against the durable resource before binding. */
  processIncarnation: string
}

export type FleetEvidenceBinding =
  | ({ kind: 'worker'; dispatchId: string } & FleetBoundTerminal)
  | ({ kind: 'pane' } & FleetBoundTerminal)
  | { kind: 'unresolved'; reason: FleetEvidenceBindingGap }

/** Use delivery only when the host explicitly lacks an observation clock; missing producer stamps cannot silently fall back. */
export type FleetEvidenceClock = { kind: 'observed'; at: number } | { kind: 'delivery'; at: number }

/** What the fleet projection reads about the agent itself. Carries no identity and no clock. */
export type FleetAgentActivity = {
  paneKey: string
  connectionId: string | null
  state: AgentStatusState
  agentType: AgentType | null
  model: string | null
  worktreeId: string | null
  restoredUnconfirmed: boolean
  providerSessionOnly: boolean
}

export type FleetAgentStatusEvidence = {
  binding: FleetEvidenceBinding
  clock: FleetEvidenceClock
  /** Replay restamps delivery past transient-clear watermarks: use it for order, never staleness. */
  deliveredAt: number
  activity: FleetAgentActivity
}

/** Explicit unidentifiable workers prevent missing handles from matching every row. */
export type FleetWorkerIdentity =
  | { kind: 'pane_and_terminal'; paneKey: string; terminalHandle: string }
  | { kind: 'terminal_only'; terminalHandle: string }
  /** No terminal handle: nothing an agent-status row could be tied to. */
  | { kind: 'unidentifiable' }

export function fleetWorkerIdentity(worker: {
  paneKey: string | null
  agentTerminalHandle: string | null
}): FleetWorkerIdentity {
  if (!worker.agentTerminalHandle) {
    return { kind: 'unidentifiable' }
  }
  return worker.paneKey
    ? {
        kind: 'pane_and_terminal',
        paneKey: worker.paneKey,
        terminalHandle: worker.agentTerminalHandle
      }
    : { kind: 'terminal_only', terminalHandle: worker.agentTerminalHandle }
}

/** Runtime owners supply identity; this constructor derives clock/activity arms consistently for every producer. */
export function mintFleetAgentStatusEvidence(
  status: AgentStatusIpcPayload,
  binding: FleetEvidenceBinding
): FleetAgentStatusEvidence {
  return {
    binding,
    clock:
      status.evidenceObservedAt !== undefined
        ? { kind: 'observed', at: status.evidenceObservedAt }
        : { kind: 'delivery', at: status.receivedAt },
    deliveredAt: status.receivedAt,
    activity: {
      paneKey: status.paneKey,
      connectionId: status.connectionId,
      state: status.state,
      agentType: status.agentType ?? null,
      model: status.model ?? null,
      worktreeId: status.worktreeId ?? null,
      restoredUnconfirmed: status.restoredUnconfirmed === true,
      providerSessionOnly: status.providerSessionOnly === true
    }
  }
}
