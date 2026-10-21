import { createContext, useContext } from 'react'

/** What a structured chat tells its rows about an Orca stop: the name of the machine whose Orca runs
 *  it, as Orca shows that host everywhere (null when it has none to show), whether that machine is a
 *  remote host rather than this desktop, and whether its host can continue a cut, which only a host
 *  known not to has no Continue for. */
export type NativeChatOrcaStopView = {
  hostLabel: string | null
  remoteHost: boolean
  continueAvailable: boolean
  /** The cut turn whose row carries Continue right now, if any. */
  offeredTurnItemId: string | null
  continueNow: () => void
  /** The turn a usage limit ended whose row carries Continue right now, if any. */
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
