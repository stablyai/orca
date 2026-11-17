import { createContext, useContext } from 'react'

export type NewTabMenuTipRoom = {
  /** Hidden to give the agent list room; the tip stays eligible and comes back with room. */
  tipHidden: boolean
  registerTip: (node: HTMLElement | null) => void
  /** Whether the tip would show at all (not kept, dismissed, hidden or customized away). */
  reportTipEligible: (eligible: boolean) => void
}

export const NewTabMenuTipRoomContext = createContext<NewTabMenuTipRoom | null>(null)

export function useNewTabMenuTipRoom(): NewTabMenuTipRoom | null {
  return useContext(NewTabMenuTipRoomContext)
}
