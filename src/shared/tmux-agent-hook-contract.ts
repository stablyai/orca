import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentStatusStore } from './agent-status/store/agent-status-store'
import type {
  AgentStatusExecutionScope,
  AgentStatusPtySubject
} from './agent-status/contracts/agent-status-subject'
import type { probeTmuxHostAttachments } from './tmux-host-attachment-probe'

export type TmuxManagedPty = {
  pid: number
  incarnation: string
  scope: AgentStatusExecutionScope
}
export type TmuxAgentHookOwnerOptions = {
  store: () => AgentStatusStore
  getRoot: (paneKey: string) => Promise<TmuxManagedPty | null>
  publish: (
    event: AgentHookEventPayload,
    observedAt: number,
    subject: AgentStatusPtySubject,
    stateStartedAt: number
  ) => void
  unavailable: (
    paneKey: string,
    subject?: AgentStatusPtySubject,
    identity?: AgentHookEventPayload
  ) => void
  probe?: typeof probeTmuxHostAttachments
  isRetired?: (paneKey: string) => boolean
  now?: () => number
}
