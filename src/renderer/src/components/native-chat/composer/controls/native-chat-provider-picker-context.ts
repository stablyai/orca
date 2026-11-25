import { createContext } from 'react'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatProviderPickerScope = {
  sessionId: string
  target: RuntimeClientTarget
  workspaceId: string
  selected: AgentSessionStatusSummary['selectedProvider']
  onError: (message: string) => void
}

export const NativeChatProviderPickerContext = createContext<NativeChatProviderPickerScope | null>(
  null
)
