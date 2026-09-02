import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export type AgentCompletionStatusSnapshot = ParsedAgentStatusPayload & {
  stateStartedAt?: number
  /** Renderer-local boundary used only to reject a delayed cross-host completion. */
  localStateStartedAt?: number
}

export type AgentCompletionDispatchMeta = {
  source: 'hook' | 'title' | 'process-exit'
  quietedHookDone: boolean
  terminalIdleConfirmed?: boolean
  agentStatus?: AgentCompletionStatusSnapshot
}

export type AgentAttentionDispatchMeta = {
  source: 'hook'
  agentStatus: AgentCompletionStatusSnapshot
}

export type AgentCompletionCoordinatorOptions = {
  paneKey: string
  statusLane?: 'hook' | 'pty'
  getPtyId: () => string | null
  getSettings: () => Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  inspectProcess: (
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
    ptyId: string
  ) => Promise<RuntimeTerminalProcessInspection>
  dispatchCompletion: (title: string, meta?: AgentCompletionDispatchMeta) => void
  dispatchAttention?: (title: string, meta: AgentAttentionDispatchMeta) => void
  dispatchHookLifecycle?: (payload: AgentCompletionStatusSnapshot) => void
  shouldSuppressProcessReplacementCompletion?: (
    exited: RecognizedAgentProcess,
    replacement: RecognizedAgentProcess
  ) => boolean
  shouldSuppressConfirmedProcessExitCompletion?: (exited: RecognizedAgentProcess) => boolean
  isLive: () => boolean
  shouldPollProcessCadence?: () => boolean
  // Why: returning false disarms the perpetual no-evidence timer so the pane
  // inspects only inside the bounded window after pane activity
  // (output/replay/title/hook). Remote panes use this — see
  // shouldPollNoEvidenceProcessCadenceForPty.
  shouldPollNoEvidenceProcessCadence?: () => boolean
  // Why: where one inspection is a whole-process-table scan (local Windows
  // PowerShell/CIM) or a host round trip plus a host-side scan (remote/SSH),
  // panes without agent evidence relax to a slow cadence and re-arm from
  // output/title/hook activity. See agent-process-inspection-cost.ts.
  isProcessInspectionCostly?: () => boolean
  shouldSuppressHookCompletion?: (payload: AgentCompletionStatusSnapshot) => boolean
}

export type AgentCompletionCoordinator = {
  observeTitle: (title: string) => void
  observeClassifiedTitleCompletion: (title: string) => void
  observeTitleWorking: () => void
  observeOutputActivity: () => void
  observeHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  seedHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  startProcessTracking: () => void
  hasPendingHookDoneCompletion: () => boolean
  resetCompletionState: (options?: { requireFreshWorking?: boolean }) => void
  dispose: () => void
}
