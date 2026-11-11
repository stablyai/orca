import { createContext, useContext } from 'react'

// Virtualized Settings lists share the page scroller.
const SettingsContentScrollElementContext = createContext<HTMLDivElement | null>(null)

export const SettingsContentScrollElementProvider = SettingsContentScrollElementContext.Provider

export function useSettingsContentScrollElement(): HTMLDivElement | null {
  return useContext(SettingsContentScrollElementContext)
}
