export type SettingsSearchState = {
  settingsSearchInputQuery: string
  /** Content filter; the sidebar search no longer drives it, so it stays empty in the app. */
  settingsSearchQuery: string
  setSettingsSearchQuery: (q: string) => void
}

export function createSettingsSearchState(
  set: (state: Partial<SettingsSearchState>) => void
): SettingsSearchState {
  return {
    settingsSearchInputQuery: '',
    settingsSearchQuery: '',
    // Why input only: the sidebar lists matching settings and the page stays unfiltered.
    setSettingsSearchQuery: (q) => set({ settingsSearchInputQuery: q })
  }
}
