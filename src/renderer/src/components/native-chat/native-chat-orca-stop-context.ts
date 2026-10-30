import { createContext, useContext } from 'react'

/** Host stop details; only hosts known not to support continuation suppress Continue. */
export type NativeChatOrcaStopView = {
  hostLabel: string | null
  remoteHost: boolean
  /** The WSL distro a WSL host runs in, so failure rows can name where an agent is missing. */
  wslDistro?: string | null
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
