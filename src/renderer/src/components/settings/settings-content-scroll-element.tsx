import { createContext, useContext } from 'react'

// Why: long Settings lists window their rows against the page's one scroller (VirtualizedList).
const SettingsContentScrollElementContext = createContext<HTMLDivElement | null>(null)

export const SettingsContentScrollElementProvider = SettingsContentScrollElementContext.Provider

export function useSettingsContentScrollElement(): HTMLDivElement | null {
  return useContext(SettingsContentScrollElementContext)
}
