import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type { RecognizedAgentProcess } from '../../../../../shared/agent-status/process/agent-process-recognition'
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
export type PendingProcessExit = {
  process: RecognizedAgentProcess
  firstObservedAtMonotonic: number
}
export type ProcessMonitorState = {
  disposed: boolean
  inspectionInFlight: boolean
  inspectionGeneration: number
  consecutiveInspectionErrors: number
  pollTrackingStarted: boolean
  pollTimer: ReturnType<typeof setTimeout> | null
  pollTimerTier: PollCadenceTier | null
  /** May lie in the future: a hidden-output notice stands for output until its window ends. */
  lastPaneActivityAt: number | null
  /** Earliest event no read has answered yet; null means no read is due. */
  readDueSince: number | null
  unresolvedFollowUps: number
  /** The foreground is a command whose exit the host cannot report, so only a read can see what follows it. */
  unwatchedForeground: boolean
  hasAgentRunEvidence: boolean
  pendingProcessExit: PendingProcessExit | null
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
  dispatchCompletion: CompletionDispatch
}
