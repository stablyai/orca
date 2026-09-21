// ─── The one identity/clock contract the fleet path reads ────────────────────
// A hook row carries a pane key, a delivery timestamp and, from newer hosts, an
// observation timestamp. Terminal identity lives on the runtime, not on the row.
// The fleet matcher needs both, and every fact it needs used to be an OPTIONAL
// field on `AgentStatusIpcPayload` — so an unenriched producer published a row the
// matcher silently failed to identify (failure table L-1) and a missing observation
// clock silently degraded to the delivery clock (W1-14 / RR-W-P1A).
//
// Here absence is an arm with a reason, never a missing property. The evidence type
// deliberately exposes no `terminalHandle?`, no `evidenceObservedAt?` and no raw
// payload, so a consumer cannot read an absent identity or clock by accident.
//
// This type never crosses IPC or the wire. `AgentStatusIpcPayload` is unchanged and
// remains what `agentStatus:set` / `agentStatus:getSnapshot` publish.

import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import type { AgentStatusState, AgentType } from './agent-status-types'

/** Why a row could not be tied to a terminal. No catch-all member: a new gap needs a name. */
export type FleetEvidenceBindingGap =
  /** The pane no longer resolves to a terminal on this runtime. */
  | 'pane_not_bound'
  /** The pane resolves to a terminal whose process incarnation is not (yet) known — a
   *  replayed row after a restart lands here rather than binding to whatever now owns the pane. */
  | 'incarnation_unbound'
  /** The pane has moved on since the row was observed, so the process the evidence describes
   *  has already exited. Reminting such a row against the pane's current identity is what let a
   *  cached observation acquire a replacement worker's incarnation and dispatch. */
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

/** The staleness clock. `delivery` is the explicit arm for a host that reports no observation
 *  clock; it is not a fallback the reader has to remember to apply. */
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
  /** Delivery order only, never a staleness input. A relay reconnect restamps this to stay
   *  monotonic past the transient-clear watermark, which is exactly what makes it the right
   *  key for ordering replays and the wrong one for measuring age. */
  deliveredAt: number
  activity: FleetAgentActivity
}

/** How a durable worker can be recognized in an evidence row. Absence is an arm, so the
 *  matcher cannot fall back to "the worker names no handle, so any handle matches". */
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

/** The only constructor. Identity is resolved by the caller that owns the runtime; the clock
 *  and the activity facts are derived here so every producer picks the same arms. */
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
