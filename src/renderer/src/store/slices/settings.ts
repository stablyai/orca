import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/types'

export type SettingsSlice = {
  settings: GlobalSettings | null
  settingsSearchQuery: string
  setSettingsSearchQuery: (q: string) => void
  fetchSettings: () => Promise<void>
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set) => ({
  settings: null,
  settingsSearchQuery: '',
  setSettingsSearchQuery: (q) => set({ settingsSearchQuery: q }),

  fetchSettings: async () => {
    try {
      const settings = await window.api.settings.get()
      set({ settings })
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    }
  },

  updateSettings: async (updates) => {
    try {
      await window.api.settings.set(updates)
      set((s) => ({
        settings: s.settings ? { ...s.settings, ...updates } : null
      }))
    } catch (err) {
      console.error('Failed to update settings:', err)
    }
  }
})
