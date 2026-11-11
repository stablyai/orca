import { createContext } from 'react'

export const SettingsTargetHighlightContext = createContext<string | null>(null)
export const SettingsTargetHighlightProvider = SettingsTargetHighlightContext.Provider
