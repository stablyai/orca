import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export type AgentCompletionStatusSnapshot = ParsedAgentStatusPayload & {
  stateStartedAt?: number
  /** Raw agent hook event name (e.g. UserPromptSubmit, PreToolUse, Stop), when
   *  the hook IPC path forwards it. Absent on the OSC/title and remote-runtime
   *  paths, which carry no hook event identity. */
  hookEventName?: string
  /** True when the originating hook event carried prompt text directly — the
   *  new-turn boundary signal. Absent unless the hook IPC path forwarded it. */
  hasExplicitPrompt?: boolean
}

export type AgentCompletionDispatchMeta = {
  source: 'hook' | 'title' | 'process-exit'
  quietedHookDone: boolean
  agentStatus?: AgentCompletionStatusSnapshot
}

export type AgentAttentionDispatchMeta = {
  source: 'hook'
  agentStatus: AgentCompletionStatusSnapshot
}

export type AgentCompletionCoordinatorOptions = {
  paneKey: string
  getPtyId: () => string | null
  getSettings: () => Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  inspectProcess: (
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
    ptyId: string
  ) => Promise<RuntimeTerminalProcessInspection>
  dispatchCompletion: (title: string, meta?: AgentCompletionDispatchMeta) => void
  dispatchAttention?: (title: string, meta: AgentAttentionDispatchMeta) => void
  isLive: () => boolean
  shouldPollProcessCadence?: () => boolean
  shouldSuppressHookCompletion?: (payload: AgentCompletionStatusSnapshot) => boolean
}

export type AgentCompletionCoordinator = {
  observeTitle: (title: string) => void
  observeClassifiedTitleCompletion: (title: string) => void
  observeTitleWorking: () => void
  observeHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  startProcessTracking: () => void
  hasPendingHookDoneCompletion: () => boolean
  resetCompletionState: (options?: { requireFreshWorking?: boolean }) => void
  dispose: () => void
}
