import type { ExecutionHostId } from '../../../../shared/execution-host'
import { createContext, useContext } from 'react'

/** Host stop details; only hosts known not to support continuation suppress Continue. */
export type NativeChatOrcaStopView = {
  heldTerminal?: {
    executionHostId: ExecutionHostId
  }
  hostLabel: string | null
  remoteHost: boolean
  continueAvailable: boolean
  offeredTurnItemId: string | null
  continueNow: () => void
  usageLimitTurnItemId: string | null
  usageLimitContinueDisabled?: boolean
  continueUsageLimit: (hadFocus?: boolean) => void
}

export const NativeChatOrcaStopContext = createContext<NativeChatOrcaStopView>({
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {},
  usageLimitTurnItemId: null,
  continueUsageLimit: () => {}
})

export function useNativeChatOrcaStopView(): NativeChatOrcaStopView {
  return useContext(NativeChatOrcaStopContext)
}
