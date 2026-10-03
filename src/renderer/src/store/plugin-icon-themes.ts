import { useEffect } from 'react'
import { create } from 'zustand'
import {
  isPluginIconThemeRegistration,
  type PluginIconThemeRegistration
} from '../../../shared/plugins/plugin-icon-theme-artifact'

type PluginIconThemeState = {
  themes: PluginIconThemeRegistration[]
  loaded: boolean
  fetchThemes: () => Promise<void>
}

let requestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginIconThemeStore = create<PluginIconThemeState>()((set) => ({
  themes: [],
  loaded: false,
  fetchThemes: async () => {
    const generation = ++requestGeneration
    const api = window.api?.plugins
    if (!api?.listIconThemes) {
      if (generation === requestGeneration) {
        set({ themes: [], loaded: true })
      }
      return
    }
    try {
      const response = await api.listIconThemes()
      const themes = Array.isArray(response) ? response.filter(isPluginIconThemeRegistration) : []
      if (!Array.isArray(response)) {
        console.warn(`[plugins] Ignoring non-array icon-theme list (${typeof response})`)
      } else if (themes.length !== response.length) {
        console.warn(
          `[plugins] Ignoring ${response.length - themes.length} of ${response.length} malformed icon themes`
        )
      }
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

export function ensurePluginIconThemesLoaded(): void {
  const state = usePluginIconThemeStore.getState()
  if (!state.loaded) {
    void state.fetchThemes()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void usePluginIconThemeStore.getState().fetchThemes()
      }
    })
  }
}

export function usePluginIconThemes(): PluginIconThemeRegistration[] {
  const themes = usePluginIconThemeStore((state) => state.themes)
  useEffect(() => ensurePluginIconThemesLoaded(), [])
  return themes
}
