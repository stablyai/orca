import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalFirstProjectWelcomeActions(
  set: TerminalStoreSet,
  _get: TerminalStoreGet
): Pick<TerminalSlice, 'showFirstProjectTerminalWelcome' | 'dismissFirstProjectTerminalWelcome'> {
  return {
    showFirstProjectTerminalWelcome: (tabId) => {
      set({ firstProjectTerminalWelcomeTabId: tabId })
    },
    dismissFirstProjectTerminalWelcome: (tabId) => {
      set((state) =>
        state.firstProjectTerminalWelcomeTabId === tabId
          ? { firstProjectTerminalWelcomeTabId: null }
          : {}
      )
    }
  }
}
