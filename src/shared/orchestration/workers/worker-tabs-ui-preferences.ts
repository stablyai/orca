import type { PersistedUIState } from '../../orca-profiles/persisted-ui-state-types'

export type WorkerTabsUiPreferences = {
  workerTabsMode: 'open-when-clicked' | 'always-open'
  workerTabHideHintShown: boolean
}

export function normalizeWorkerTabsUiPreferences(
  ui: Pick<PersistedUIState, 'workerTabsMode' | 'workerTabHideHintShown'> | undefined
): WorkerTabsUiPreferences {
  return {
    workerTabsMode: ui?.workerTabsMode === 'always-open' ? 'always-open' : 'open-when-clicked',
    workerTabHideHintShown: ui?.workerTabHideHintShown === true
  }
}
