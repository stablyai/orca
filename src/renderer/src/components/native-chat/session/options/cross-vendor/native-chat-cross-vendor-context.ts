import { createContext, useContext } from 'react'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatCrossVendorControl = {
  currentAgent: string
  worktreeId: string | null
  target: RuntimeClientTarget
  /** Why another vendor cannot take over now (a turn is running); null when it can. */
  blockedReason: string | null
  /** The agent a switch is starting, while it starts. */
  switching: TuiAgent | null
  switchTo: (agent: TuiAgent, model?: string, effort?: string) => void
}

/** Present only in a structured chat that can continue with another vendor's agent. */
export const NativeChatCrossVendorContext = createContext<NativeChatCrossVendorControl | null>(null)

export const useNativeChatCrossVendor = (): NativeChatCrossVendorControl | null =>
  useContext(NativeChatCrossVendorContext)
