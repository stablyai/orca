// ─── Wire shapes carried from the hook receivers to the renderer over IPC ────
// Why: split out of agent-status-types so that module stays the status vocabulary
// (states, entries, normalization) and the transport envelopes live next to each
// other. Re-exported from agent-status-types, so existing import sites are unchanged.

import type { StructuredHostStatus } from './agent-hook-listener/listener-event'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { WithAgentStatusObservation } from './agent-status-observation'
import type {
  AgentStatusExecutionId,
  AgentStatusProviderAlias,
  AgentStatusRunId
} from './agent-status-run'
import type {
  AgentStatusOrchestrationContext,
  ParsedAgentStatusPayload
} from './agent-status-types'

/** A PTY the pane-key migration could not move, reported for operator triage. */
export type MigrationUnsupportedPtyEntry = {
  ptyId: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  /** Registry-backed UUID pane proof, when available. */
  paneKey?: string
  reason: 'legacy-numeric-pane-key'
  source: 'local' | 'ssh'
  updatedAt: number
}

/** The provider's own report that it accepted a prompt: when the store recorded it, and the
 *  provider's turn id when its hook names one. Live-only, never persisted. */
export type AgentPromptAcceptance = {
  acceptedAt: number
  providerTurnId?: string
}

export type AgentStatusIpcPayload = ParsedAgentStatusPayload & {
  /** Optional run-aware identity; absent on legacy hosts and compatibility projections. */
  runId?: AgentStatusRunId
  /** Host-owned process-incarnation attachment for the run-aware row. */
  executionId?: AgentStatusExecutionId
  /** Fully qualified provider identity; never a credential or mailbox lookup key. */
  providerAlias?: AgentStatusProviderAlias
  paneKey: string
  /** Live host acknowledgement of this renderer’s exact pane retirement. */
  authorityRestartId?: string
  launchToken?: string
  terminalHandle?: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Only the remote-ingest path (`ingestRemote`) can stamp it from mux identity; the HTTP path has no mux and always sets null. */
  connectionId: string | null
  /** Timestamp (ms) when the hook server received this latest status event. */
  receivedAt: number
  /** When the reported evidence was first observed, as distinct from `receivedAt` (delivery
   *  order). A relay reconnect replays cached rows, and `receivedAt` must restamp to stay
   *  monotonic past the transient-clear watermark — so only this clock can measure staleness.
   *  Optional: absent from old hosts, where consumers fall back to `receivedAt`. */
  evidenceObservedAt?: number
  /** Timestamp (ms) when the current state first appeared for this pane. */
  stateStartedAt: number
  orchestration?: AgentStatusOrchestrationContext
  providerSession?: AgentProviderSessionMetadata
  /** Resume identity update only; the status-shaped fields are transport placeholders. */
  providerSessionOnly?: boolean
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
  /** The main agent's latest accepted prompt on this pane; live-only. */
  promptAcceptance?: AgentPromptAcceptance
  /** See AgentStatusEntry.restoredUnconfirmed — hydrated nonterminal provenance. */
  restoredUnconfirmed?: boolean
  /** Present on rows the structured session host projects; `owned` keeps them fresh past the
   *  staleness window because the host still runs the provider child. */
  structuredHost?: StructuredHostStatus
} & WithAgentStatusObservation

/** Identity used by UI-only cleanup to evict exactly the status it cleared.
 *  Deliberately minimal — receivedAt + stateStartedAt pin the exact event instance
 *  (the same baseline the interrupt-inference guard uses). Renderer-enriched fields
 *  (connectionId, worktreeId) diverge from main's cache and must not participate. */
export type AgentStatusCacheIdentity = {
  paneKey: string
  receivedAt: number
  stateStartedAt: number
}

/** Wire shape for ordinary pane teardown or a stamped SSH disconnect batch. */
export type AgentStatusClearIpcPayload =
  | { paneKey: string }
  | {
      transient: true
      connectionId: string
      clearedAt: number
    }
