import { createContext, useContext } from 'react'

// A folder card's header hosts its panel's filter and overflow buttons; null while the card is collapsed.
export const SourceControlHeaderActionsSlot = createContext<HTMLElement | null>(null)

export function useSourceControlHeaderActionsSlot(): HTMLElement | null {
  return useContext(SourceControlHeaderActionsSlot)
}
