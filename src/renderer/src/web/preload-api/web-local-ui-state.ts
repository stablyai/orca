import { getDefaultUIState, getWorktreeCardModeProperties } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { mergeWebUIState } from './web-preference-normalization'
import { UI_STORAGE_KEY, readJson } from './web-storage'

export function readWebUIStateForSettings(storedSettings: GlobalSettings): PersistedUIState {
  const defaults = getDefaultUIState()
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  const base = {
    ...defaults,
    // Match the host's legacy card-layout seed when its UI read is unavailable.
    worktreeCardProperties: getWorktreeCardModeProperties(
      storedSettings.compactWorktreeCards ? 'Compact' : 'Default'
    )
  }
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(base, stored)
  }
  return mergeWebUIState(base, {
    ...stored,
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}
