import type { PersistedUIState } from './persisted-ui-state-types'

// Pairing-local views use each client’s host catalog/viewport; forwarding them would overwrite another client’s choices.
// Strip on ui.set and pin local values on ui.get.
export const PAIRING_LOCAL_UI_FIELDS = [
  // Host keys are client-relative (desktop means another machine); older hosts reject this key.
  'automationHostFilter',
  // Except for the host's own phone, which shows the host's view (isHostOwnPhone, client-ui.ts).
  'hideWorkspacesFromOtherDevices',
  'manualRepoOrder',
  'workspaceHostOrder',
  // A phone-width browser and a desktop window each choose their own left sidebar, and old hosts reject the unknown key.
  'sidebarOpen',
  // Agent View filters and presentation belong to each client's host catalog and viewport.
  'agentsVisibleHostIds',
  'agentsFilterRepoIds',
  'agentsHideWorkspacesFromOtherDevices',
  'agentsHideAutomationGeneratedWorkspaces',
  'agentsHideCliCreatedWorkspaces',
  'agentsShowChildAgents',
  'agentsCompactMode',
  'agentsShowSearch',
  'agentsReadFilter',
  'agentsGroupBy',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const satisfies readonly (keyof PersistedUIState)[]

export type PairingLocalUiField = (typeof PAIRING_LOCAL_UI_FIELDS)[number]

// Omit pairing-local fields from host response types so accidental reads fail compilation.
export type PairedUiState = Omit<PersistedUIState, PairingLocalUiField>

const PAIRING_LOCAL_UI_FIELD_SET: ReadonlySet<string> = new Set(PAIRING_LOCAL_UI_FIELDS)

// Accept arbitrary objects because ui.set’s Zod-inferred optionality differs from persisted state.
export function omitPairingLocalUiFields<T extends object>(state: T): Omit<T, PairingLocalUiField> {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => !PAIRING_LOCAL_UI_FIELD_SET.has(key))
  ) as Omit<T, PairingLocalUiField>
}
