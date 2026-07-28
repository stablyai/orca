import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginTerminalThemeRegistration } from '../../../shared/plugins/plugin-terminal-theme-artifact'

type PluginTerminalThemeState = {
  themes: PluginTerminalThemeRegistration[]
  loaded: boolean
  fetchThemes: () => Promise<void>
}

let requestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginTerminalThemeStore = create<PluginTerminalThemeState>()((set) => ({
  themes: [],
  loaded: false,
  fetchThemes: async () => {
    const generation = ++requestGeneration
    try {
      const themes = (await window.api?.plugins?.listTerminalThemes?.()) ?? []
      if (generation === requestGeneration) {
        set({ themes, loaded: true })
      }
    } catch {
      if (generation === requestGeneration) {
        set({ themes: [], loaded: true })
      }
    }
  }
}))

export function ensurePluginTerminalThemesLoaded(): void {
  const state = usePluginTerminalThemeStore.getState()
  if (!state.loaded) {
    void state.fetchThemes()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void usePluginTerminalThemeStore.getState().fetchThemes()
      }
    })
  }
}

export function usePluginTerminalThemes(): PluginTerminalThemeRegistration[] {
  const themes = usePluginTerminalThemeStore((state) => state.themes)
  useEffect(() => ensurePluginTerminalThemesLoaded(), [])
  return themes
}
