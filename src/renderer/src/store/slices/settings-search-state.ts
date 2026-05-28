export const SETTINGS_SEARCH_DEBOUNCE_MS = 150

export type SettingsSearchState = {
  settingsSearchInputQuery: string
  settingsSearchQuery: string
  setSettingsSearchQuery: (q: string) => void
}

export function createSettingsSearchState(
  set: (state: Partial<SettingsSearchState>) => void
): SettingsSearchState {
  let settingsSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  const clearSettingsSearchDebounce = (): void => {
    if (settingsSearchDebounceTimer) {
      clearTimeout(settingsSearchDebounceTimer)
      settingsSearchDebounceTimer = null
    }
  }

  return {
    settingsSearchInputQuery: '',
    settingsSearchQuery: '',
    setSettingsSearchQuery: (q) => {
      clearSettingsSearchDebounce()
      if (q.trim() === '') {
        set({ settingsSearchInputQuery: q, settingsSearchQuery: q })
        return
      }
      set({ settingsSearchInputQuery: q })
      // Why: applying settings search mounts and filters many heavy sections,
      // so keep typing responsive while waiting for the query to settle.
      settingsSearchDebounceTimer = setTimeout(() => {
        settingsSearchDebounceTimer = null
        set({ settingsSearchQuery: q })
      }, SETTINGS_SEARCH_DEBOUNCE_MS)
    }
  }
}
