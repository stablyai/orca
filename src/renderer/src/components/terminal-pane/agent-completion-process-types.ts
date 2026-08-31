import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type {
  AgentCompletionIdentityScope,
  LastCompletionIdentity
} from './agent-completion-identity-store'
import type { PendingTitleController } from './agent-completion-pending-title'
import type { PollCadenceTier } from './agent-completion-poll-cadence'

export type CompletionSource = 'hook' | 'title' | 'process-exit'
export type CompletionDispatch = (
  source: CompletionSource,
  title: string,
  options?: { terminalIdleConfirmed?: boolean; completionIdentity?: LastCompletionIdentity | null }
) => boolean
export type ProcessMonitorState = {
  disposed: boolean
  inspectionInFlight: boolean
  inspectionGeneration: number
  consecutiveInspectionErrors: number
  pollTrackingStarted: boolean
  pollTimer: ReturnType<typeof setTimeout> | null
  pollTimerTier: PollCadenceTier | null
  lastPaneActivityAt: number
  hasAgentRunEvidence: boolean
  pendingProcessExitAgent: RecognizedAgentProcess | null
  lastForegroundAgent: RecognizedAgentProcess | null
  processSession: number
}
export type ProcessMonitorOptions = {
  options: AgentCompletionCoordinatorOptions
  state: ProcessMonitorState
  identityScope: AgentCompletionIdentityScope
  pendingTitle: PendingTitleController
  establishAgentEvidence: () => void
  clearAgentRunEvidence: () => void
  hasPendingHookDone: () => boolean
  hasPendingCodexAttention: () => boolean
  dispatchCompletion: CompletionDispatch
}
