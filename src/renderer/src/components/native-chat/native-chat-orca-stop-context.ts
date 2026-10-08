import { createContext, useContext } from 'react'

/** What a structured chat tells its rows about an Orca stop: the name of the machine whose Orca runs
 *  it, as Orca shows that host everywhere (null when it has none to show), and whether its host can
 *  continue a cut, which only a host known not to has no Continue for. */
export type NativeChatOrcaStopView = {
  hostLabel: string | null
  continueAvailable: boolean
}

export const NativeChatOrcaStopContext = createContext<NativeChatOrcaStopView>({
  hostLabel: null,
  continueAvailable: false
})

export function useNativeChatOrcaStopView(): NativeChatOrcaStopView {
  return useContext(NativeChatOrcaStopContext)
}
