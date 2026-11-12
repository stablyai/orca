// Keep transport envelopes separate from status vocabulary; re-export through agent-status-types for existing consumers.

import type { StructuredHostStatus } from '../../agent-hook-listener/listener-event'
import type { ProgramStatusFacet } from '../../program-status/facet'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import type { WithAgentStatusObservation } from './agent-status-observation'
import type {
  AgentStatusExecutionId,
  AgentStatusProviderAlias,
  AgentStatusRunId
} from './agent-status-run'
import type {
  AgentStatusOrchestrationContext,
  AgentType,
  ParsedAgentStatusPayload,
  TurnEndDisposition
} from './agent-status-types'

export function readPaneSleep(value: unknown): AgentStatusIpcPayload['paneSleep'] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('ptyId' in value) ||
    typeof value.ptyId !== 'string' ||
    value.ptyId.length === 0 ||
    value.ptyId.length > 1024
  ) {
    return undefined
  }
  const incarnationId = 'incarnationId' in value ? value.incarnationId : undefined
  if (
    incarnationId !== undefined &&
    (typeof incarnationId !== 'string' || incarnationId.length === 0 || incarnationId.length > 1024)
  ) {
    return undefined
  }
  return { ptyId: value.ptyId, ...(incarnationId ? { incarnationId } : {}) }
}

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
  /** The host proved this exact process stopped for sleep; the placed pane owns its Done. */
  paneSleep?: { ptyId: string; incarnationId?: string }
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
  /** The host's statement on the Orca launch in this pane: its note, or null for none; absent says nothing. */
  launchConfig?: SleepingAgentLaunchConfig | null
  terminalHandle?: string
  tabId?: string
  worktreeId?: string
  /** Remote ingest alone stamps mux connection identity; null for local/HTTP paths without a mux. */
  connectionId: string | null
  /** Timestamp (ms) when the hook server received this latest status event. */
  receivedAt: number
  /** Original evidence clock for freshness; receivedAt restamps reconnect replays past clear watermarks. Older hosts omit it and readers fall back to receivedAt. */
  evidenceObservedAt?: number
  /** Timestamp (ms) when the current state first appeared for this pane. */
  stateStartedAt: number
  /** Host-stamped lead turn opening; older hosts/unseen openings fall back to stateStartedAt. */
  turnStartedAt?: number
  /** Host-stamped lead turn end, retained across restatements; omitted by old hosts/unclassified agents. */
  turnEndedAt?: number
  /** How the host identified that end; absent from old hosts (legacy). */
  turnEndDisposition?: TurnEndDisposition
  orchestration?: AgentStatusOrchestrationContext
  providerSession?: AgentProviderSessionMetadata
  /** Resume identity update only; the status-shaped fields are transport placeholders. */
  providerSessionOnly?: boolean
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
  /** See AgentStatusEntry.programStatus. Live-only; older peers ignore it. */
  programStatus?: ProgramStatusFacet
  /** Only `programStatus` changed: readers patch the facet and treat nothing else as news. */
  programStatusOnly?: true
  /** See AgentStatusEntry.restoredUnconfirmed — hydrated nonterminal provenance. */
  restoredUnconfirmed?: boolean
  /** The pane's owning agent session on its execution host; absent from older hosts. */
  paneOwner?: { agent: AgentType; session: string }
  /** A re-send of a cached row (reconnect or listener replay), not a new transition. */
  isReplay?: boolean
  /** Present on rows the structured session host projects; `owned` keeps them fresh past the
   *  staleness window because the host still runs the provider child. */
  structuredHost?: StructuredHostStatus
} & WithAgentStatusObservation

/** Match exact UI-cleared events by receivedAt/stateStartedAt. Exclude renderer-enriched connection/worktree attribution that differs from main's cache. */
export type AgentStatusCacheIdentity = {
  paneKey: string
  receivedAt: number
  stateStartedAt: number
}

/** A pane's saved resume the host refused because a native chat is that conversation's home. */
export type RefusedPaneResume = {
  expectedStatus?: AgentStatusCacheIdentity
  expectedSavedRecord?: { paneKey: string; capturedAt: number; updatedAt: number }
  agent: string
  providerSession: AgentProviderSessionMetadata
}

/** Wire shape for ordinary pane teardown or a stamped SSH disconnect batch. */
export type AgentStatusClearIpcPayload =
  | {
      paneKey: string
      statusUnavailable?: true
      /** An OSC 7501 program took back its own row, so even a `done` row goes. */
      programStatusRemoved?: true
      /** Forget that conversation as this pane's resume target too, not only its status. */
      refusedResume?: RefusedPaneResume
    }
  | {
      transient: true
      connectionId: string
      clearedAt: number
    }
