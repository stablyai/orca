import { createContext, useContext } from 'react'

export type NewTabMenuTipRoom = {
  /** Gave its room to the agent list; stays hidden until the menu next opens. */
  tipHidden: boolean
  registerTip: (node: HTMLElement | null) => void
}

export const NewTabMenuTipRoomContext = createContext<NewTabMenuTipRoom | null>(null)

export function useNewTabMenuTipRoom(): NewTabMenuTipRoom | null {
  return useContext(NewTabMenuTipRoomContext)
}
