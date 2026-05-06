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
      set((s) => {
        if (!s.settings) {
          return { settings: null }
        }
        // Deep-merge telemetry so partial writes do not clobber sibling
        // fields like `installId`, `existedBeforeTelemetryRelease`, or
        // `optedIn` in local renderer state until the next fetchSettings.
        // Mirrors the main-side merge in src/main/persistence.ts:551-573.
        // `telemetry` is optional on GlobalSettings, so guard against the case
        // where both current and incoming telemetry are undefined — otherwise
        // the spread would produce an empty object and we'd materialize a
        // telemetry key that shouldn't exist.
        const mergedTelemetry =
          updates.telemetry !== undefined
            ? { ...s.settings.telemetry, ...updates.telemetry }
            : s.settings.telemetry
        return {
          settings: {
            ...s.settings,
            ...updates,
            notifications: {
              ...s.settings.notifications,
              ...updates.notifications
            },
            ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {})
          }
        }
      })
    } catch (err) {
      console.error('Failed to update settings:', err)
    }
  }
})
