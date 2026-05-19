import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export type AgentCompletionCoordinatorOptions = {
  paneKey: string
  getPtyId: () => string | null
  getSettings: () => Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  inspectProcess: (
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
    ptyId: string
  ) => Promise<RuntimeTerminalProcessInspection>
  dispatchCompletion: (title: string) => void
  isLive: () => boolean
}

export type AgentCompletionCoordinator = {
  observeTitle: (title: string) => void
  observeClassifiedTitleCompletion: (title: string) => void
  observeTitleWorking: () => void
  observeHookStatus: (payload: ParsedAgentStatusPayload) => void
  startProcessTracking: () => void
  resetCompletionState: (options?: { requireFreshWorking?: boolean }) => void
  dispose: () => void
}
