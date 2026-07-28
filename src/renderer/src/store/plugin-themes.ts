import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginThemeRegistration } from '../../../shared/plugins/plugin-theme-artifact'

type PluginThemeState = {
  themes: PluginThemeRegistration[]
  loaded: boolean
  fetchThemes: () => Promise<void>
}

let requestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginThemeStore = create<PluginThemeState>()((set) => ({
  themes: [],
  loaded: false,
  fetchThemes: async () => {
    const generation = ++requestGeneration
    const api = window.api?.plugins
    if (!api?.listThemes) {
      if (generation === requestGeneration) {
        set({ themes: [], loaded: true })
      }
      return
    }
    try {
      const themes = await api.listThemes()
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

export function ensurePluginThemesLoaded(): void {
  const state = usePluginThemeStore.getState()
  if (!state.loaded) {
    void state.fetchThemes()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void usePluginThemeStore.getState().fetchThemes()
      }
    })
  }
}

export function usePluginThemes(): PluginThemeRegistration[] {
  const themes = usePluginThemeStore((state) => state.themes)
  useEffect(() => ensurePluginThemesLoaded(), [])
  return themes
}
