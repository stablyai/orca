import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginIconThemeRegistration } from '../../../shared/plugins/plugin-icon-theme-artifact'

type PluginIconThemeState = {
  themes: PluginIconThemeRegistration[]
  loaded: boolean
  /** Every rendered file icon calls ensure…Loaded; without this each one would
   *  start its own IPC transfer of the full theme payload before `loaded` flips. */
  loading: boolean
  fetchThemes: () => Promise<void>
}

let requestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginIconThemeStore = create<PluginIconThemeState>()((set) => ({
  themes: [],
  loaded: false,
  loading: false,
  fetchThemes: async () => {
    const generation = ++requestGeneration
    set({ loading: true })
    const settle = (themes: PluginIconThemeRegistration[]): void => {
      if (generation === requestGeneration) {
        set({ themes, loaded: true, loading: false })
      }
    }
    const api = window.api?.plugins
    if (!api?.listIconThemes) {
      settle([])
      return
    }
    try {
      settle(await api.listIconThemes())
    } catch {
      settle([])
    }
  }
}))

export function ensurePluginIconThemesLoaded(): void {
  const state = usePluginIconThemeStore.getState()
  if (!state.loaded && !state.loading) {
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
