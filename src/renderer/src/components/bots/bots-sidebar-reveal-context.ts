// What the Bots section's rows read of a live "Reveal current" request.
import { createContext, useContext, useEffect } from 'react'
import type { SidebarBotsRevealTarget } from '../../../../shared/sidebar-list/sidebar-reveal-target'

export type BotsRevealRequest = {
  target: SidebarBotsRevealTarget
  nonce: number
  beginRename: boolean
}

export type BotsRevealContextValue = {
  request: BotsRevealRequest | null
  /** The bot's rows under it are final for this request: its chat read answered, or nothing lists there. */
  settle: (nonce: number) => void
}

const BotsRevealContext = createContext<BotsRevealContextValue>({
  request: null,
  settle: () => {}
})

export const BotsRevealProvider = BotsRevealContext.Provider

/** The live request when it names this row, else null. */
export function useBotsRevealRequest(entryKey: string): BotsRevealRequest | null {
  const { request } = useContext(BotsRevealContext)
  return request?.target.entryKey === entryKey ? request : null
}

/** Tells the section this bot's rows are final once `settled` holds for the live request naming it. */
export function useBotsRevealSettle(entryKey: string, settled: boolean): void {
  const { request, settle } = useContext(BotsRevealContext)
  const nonce = request?.target.entryKey === entryKey ? request.nonce : null
  useEffect(() => {
    if (nonce !== null && settled) {
      settle(nonce)
    }
  }, [nonce, settled, settle])
}
