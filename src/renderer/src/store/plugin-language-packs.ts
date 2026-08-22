import { useEffect } from 'react'
import { create } from 'zustand'
import {
  isPluginLanguagePackRegistration,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/plugin-language-pack-artifact'

type PluginLanguagePackState = {
  packs: PluginLanguagePackRegistration[]
  loaded: boolean
  fetchPacks: () => Promise<void>
}

let requestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginLanguagePackStore = create<PluginLanguagePackState>()((set) => ({
  packs: [],
  loaded: false,
  fetchPacks: async () => {
    const generation = ++requestGeneration
    const api = window.api?.plugins
    if (!api?.listLanguagePacks) {
      if (generation === requestGeneration) {
        set({ packs: [], loaded: true })
      }
      return
    }
    try {
      const response = await api.listLanguagePacks()
      const packs = Array.isArray(response) ? response.filter(isPluginLanguagePackRegistration) : []
      // Why: a non-array response and a rejected member are different upstream bugs; keep them distinguishable in the log.
      if (!Array.isArray(response)) {
        console.warn(`[plugins] Ignoring non-array language-pack list (${typeof response})`)
      } else if (packs.length !== response.length) {
        console.warn(
          `[plugins] Ignoring ${response.length - packs.length} of ${response.length} malformed language packs`
        )
      }
      if (generation === requestGeneration) {
        set({ packs, loaded: true })
      }
    } catch {
      if (generation === requestGeneration) {
        set({ packs: [], loaded: true })
      }
    }
  }
}))

export function ensurePluginLanguagePacksLoaded(): void {
  const state = usePluginLanguagePackStore.getState()
  if (!state.loaded) {
    void state.fetchPacks()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void usePluginLanguagePackStore.getState().fetchPacks()
      }
    })
  }
}

export function usePluginLanguagePacks(): PluginLanguagePackRegistration[] {
  const packs = usePluginLanguagePackStore((state) => state.packs)
  useEffect(() => ensurePluginLanguagePacksLoaded(), [])
  return packs
}
