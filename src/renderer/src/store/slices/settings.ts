import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/types'
import { normalizeTerminalQuickCommands } from '../../../../shared/terminal-quick-commands'

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
      const sanitizedUpdates = { ...updates }
      if ('terminalQuickCommands' in updates) {
        sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
          updates.terminalQuickCommands
        )
      }
      await window.api.settings.set(sanitizedUpdates)
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
          sanitizedUpdates.telemetry !== undefined
            ? { ...s.settings.telemetry, ...sanitizedUpdates.telemetry }
            : s.settings.telemetry
        // Why: voice is optional and partially writable (e.g. only `selectedModelId`
        // changes), so deep-merge sibling fields like `mode` and `holdShortcut`
        // and avoid materializing a `voice` key when neither current nor incoming
        // settings define one.
        const mergedVoice =
          updates.voice !== undefined
            ? { ...s.settings.voice, ...updates.voice }
            : s.settings.voice
        return {
          settings: {
            ...s.settings,
            ...sanitizedUpdates,
            notifications: {
              ...s.settings.notifications,
              ...sanitizedUpdates.notifications
            },
            ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {}),
            ...(mergedVoice !== undefined ? { voice: mergedVoice } : {})
          }
        }
      })
    } catch (err) {
      console.error('Failed to update settings:', err)
    }
  }
})
