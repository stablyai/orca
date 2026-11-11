import { getDefaultUIState, getWorktreeCardModeProperties } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { readAcceptedChecklistVisibility } from './web-checklist-visibility-revision'
import { mergeWebUIState } from './web-preference-normalization'
import { getStoredSettings } from './web-preferences-store'
import { UI_STORAGE_KEY, readJson } from './web-storage'

export function readLocalWebUIState(): PersistedUIState {
  const defaults = getDefaultUIState()
  // Settings migration arms OSC 52’s UI notice; reading UI first would later overwrite that arm after its one-shot stamp.
  const storedSettings = getStoredSettings()
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  const acceptedChecklistVisibility = readAcceptedChecklistVisibility()
  const localStored =
    typeof acceptedChecklistVisibility === 'boolean'
      ? { ...stored, setupGuideSettingsDismissed: acceptedChecklistVisibility }
      : stored
  const base = {
    ...defaults,
    // Why: mirror the main-process missing-property seed from legacy card layout mode when runtime ui.get is unavailable.
    worktreeCardProperties: getWorktreeCardModeProperties(
      storedSettings.compactWorktreeCards ? 'Compact' : 'Default'
    )
  }
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(base, localStored)
  }
  return mergeWebUIState(base, {
    ...localStored,
    // Why: web fallback lacks main-process normalization; migrate the retired setting only when local UI preference is absent.
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}
