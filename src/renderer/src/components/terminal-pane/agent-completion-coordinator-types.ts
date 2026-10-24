import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload,
  TurnEndDisposition
} from '../../../../shared/agent-status-types'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TerminalProcessInspection } from '../../../../shared/terminal-process-inspection'

export type AgentCompletionStatusSnapshot = ParsedAgentStatusPayload &
  Partial<
    Pick<
      AgentStatusIpcPayload,
      | 'runId'
      | 'executionId'
      | 'terminalHandle'
      | 'connectionId'
      | 'turnStartedAt'
      | 'authorityRestartId'
      | 'isReplay'
      | 'restoredUnconfirmed'
    >
  > & {
    stateStartedAt?: number
    turnEndedAt?: number
    turnEndDisposition?: TurnEndDisposition
    /** Renderer-local boundary used only to reject a delayed cross-host completion. */
    localStateStartedAt?: number
  }

export type AgentCompletionHookCandidate = {
  snapshot: AgentCompletionStatusSnapshot
  originalRow: AgentStatusIpcPayload
}

export type AgentCompletionDispatchMeta = {
  source: 'hook' | 'title' | 'process-exit'
  quietedHookDone: boolean
  hookCandidate?: AgentCompletionHookCandidate
  terminalIdleConfirmed?: boolean
  agentStatus?: AgentCompletionStatusSnapshot
}

export type AgentAttentionDispatchMeta = {
  hookCandidate?: AgentCompletionHookCandidate
  source: 'hook'
  agentStatus: AgentCompletionStatusSnapshot
}

export type AgentCompletionCoordinatorOptions = {
  paneKey: string
  statusLane?: 'hook' | 'pty'
  getPtyId: () => string | null
  /** Remote authorities are event-triggered only; no periodic process polls. */
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
  inspectProcess: (
    ptyId: string,
    options?: { expectedIncarnationId?: string; steadyState?: boolean }
  ) => Promise<TerminalProcessInspection>
  dispatchCompletion: (title: string, meta?: AgentCompletionDispatchMeta) => void
  dispatchAttention?: (title: string, meta: AgentAttentionDispatchMeta) => void
  dispatchHookLifecycle?: (payload: AgentCompletionStatusSnapshot) => void
  shouldSuppressProcessReplacementCompletion?: (
    exited: RecognizedAgentProcess,
    replacement: RecognizedAgentProcess
  ) => boolean
  shouldSuppressConfirmedProcessExitCompletion?: (exited: RecognizedAgentProcess) => boolean
  /** Fired once per confirmed exit (settled local absence, or the host's `exited` verdict). */
  onForegroundAgentExited?: (exited: RecognizedAgentProcess) => void
  isLive: () => boolean
  /** How the hook lane identified the turn end a title edge (null: no title known) would announce:
   *  `identified` it announces it; `ambiguous` the title lane keeps main's role; null not hook-owned. */
  titleTurnEndEvidence?: (
    title: string | null,
    foregroundAgent: RecognizedAgentProcess['agent'] | null
  ) => 'identified' | 'ambiguous' | null
  /** An idle edge whose turn end the hook lane announces still ends this output burst. */
  onHookOwnedTitleIdle?: () => void
  /** Whether a hook snapshot's end is hook-owned on this pane (else main's behavior exactly). */
  usesHookTurnEnds?: (snapshot: AgentCompletionStatusSnapshot) => boolean
  shouldPollProcessCadence?: () => boolean
  // Why: a host that publishes foreground evidence with its inventory lets a
  // pane without agent evidence stay push-driven instead of scheduling
  // redundant host process-table reads while idle. Wire a producer only once
  // this renderer CONSUMES that evidence and can tell "no evidence published"
  // from "host too old to publish it" — mixed-version hosts omit the field.
  shouldPollNoEvidenceProcessCadence?: () => boolean
  // Why: where one inspection is a whole-process-table scan (local Windows
  // PowerShell/CIM) or a host round trip plus a host-side scan (remote/SSH),
  // panes without agent evidence relax to a slow cadence and re-arm from
  // output/title/hook activity. See agent-process-inspection-cost.ts.
  isProcessInspectionCostly?: () => boolean
}

export type AgentCompletionCoordinator = {
  observeTitle: (title: string) => void
  observeClassifiedTitleCompletion: (title: string) => void
  observeTitleWorking: () => void
  observeOutputActivity: () => void
  observeHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  seedHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  startProcessTracking: () => void
  /** Another reader saw this agent in the foreground; lets the monitor confirm its exit. */
  observeForegroundAgentProcess: (process: RecognizedAgentProcess) => void
  hasPendingHookDoneCompletion: () => boolean
  /** Whether a turn end observed now could be announced (live, with agent evidence, not re-arming). */
  canAnnounceCompletion: () => boolean
  resetCompletionState: (options?: { requireFreshWorking?: boolean }) => void
  dispose: () => void
}
