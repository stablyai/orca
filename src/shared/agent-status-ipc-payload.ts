// ─── Wire shapes carried from the hook receivers to the renderer over IPC ────
// Why: split out of agent-status-types so that module stays the status vocabulary
// (states, entries, normalization) and the transport envelopes live next to each
// other. Re-exported from agent-status-types, so existing import sites are unchanged.

import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { WithAgentStatusObservation } from './agent-status-observation'
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

export type AgentStatusIpcPayload = ParsedAgentStatusPayload & {
  paneKey: string
  launchToken?: string
  terminalHandle?: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Only the remote-ingest path (`ingestRemote`) can stamp it from mux identity; the HTTP path has no mux and always sets null. */
  connectionId: string | null
  /** Timestamp (ms) when the hook server received this latest status event. */
  receivedAt: number
  /** Timestamp (ms) when the current state first appeared for this pane. */
  stateStartedAt: number
  orchestration?: AgentStatusOrchestrationContext
  providerSession?: AgentProviderSessionMetadata
  /** Resume identity update only; the status-shaped fields are transport placeholders. */
  providerSessionOnly?: boolean
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
  /** See AgentStatusEntry.restoredUnconfirmed — hydrated nonterminal provenance. */
  restoredUnconfirmed?: boolean
} & WithAgentStatusObservation

/** Wire shape for ordinary pane teardown or a stamped SSH disconnect batch. */
export type AgentStatusClearIpcPayload =
  | { paneKey: string }
  | {
      transient: true
      connectionId: string
      clearedAt: number
    }
