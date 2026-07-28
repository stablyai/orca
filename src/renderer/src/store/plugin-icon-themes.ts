import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  PluginIconThemeMetadata,
  PluginIconThemeRegistration
} from '../../../shared/plugins/plugin-icon-theme-artifact'

type PluginIconThemeState = {
  themes: PluginIconThemeMetadata[]
  activeId: `plugin:${string}` | null
  activeTheme: PluginIconThemeRegistration | null
  loaded: boolean
  fetchThemes: () => Promise<void>
  loadActiveTheme: () => Promise<void>
  setActiveId: (id: `plugin:${string}` | null) => void
}

let requestGeneration = 0
let activeRequestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginIconThemeStore = create<PluginIconThemeState>()((set, get) => ({
  themes: [],
  activeId: null,
  activeTheme: null,
  loaded: false,
  fetchThemes: async () => {
    const generation = ++requestGeneration
    try {
      const themes = (await window.api?.plugins?.listIconThemes?.()) ?? []
      if (generation === requestGeneration) {
        set({ themes, loaded: true })
        await get().loadActiveTheme()
      }
    } catch {
      if (generation === requestGeneration) {
        set({ themes: [], loaded: true })
        await get().loadActiveTheme()
      }
    }
  },
  loadActiveTheme: async () => {
    const generation = ++activeRequestGeneration
    const { activeId, themes } = get()
    if (!activeId || !themes.some((theme) => theme.id === activeId)) {
      set({ activeTheme: null })
      return
    }
    try {
      const activeTheme = (await window.api?.plugins?.loadIconTheme?.(activeId)) ?? null
      if (generation === activeRequestGeneration && get().activeId === activeId) {
        set({ activeTheme })
      }
    } catch {
      if (generation === activeRequestGeneration && get().activeId === activeId) {
        set({ activeTheme: null })
      }
    }
  },
  setActiveId: (activeId) => {
    set({ activeId })
    void get().loadActiveTheme()
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

export function usePluginIconThemes(): PluginIconThemeMetadata[] {
  const themes = usePluginIconThemeStore((state) => state.themes)
  useEffect(() => ensurePluginIconThemesLoaded(), [])
  return themes
}
