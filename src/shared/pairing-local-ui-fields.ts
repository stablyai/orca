import type { PersistedUIState } from './persisted-ui-state-types'

export const PAIRING_LOCAL_UI_FIELDS = [
  // Its hostKey names authorities only the writing client can resolve — a paired
  // client's `desktop` is a different machine — and old hosts reject the unknown key.
  'automationHostFilter',
  'hideWorkspacesFromOtherDevices',
  'manualRepoOrder',
  'workspaceHostOrder',
  // Paired clients may choose to watch different Claude quotas.
  'claudeCompactMetric',
  // Agent View filters and presentation belong to each client's host catalog and viewport.
  'agentsVisibleHostIds',
  'agentsFilterRepoIds',
  'agentsShowChildAgents',
  'agentsCompactMode',
  'agentsShowSearch',
  'agentsReadFilter',
  'agentsGroupBy',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const satisfies readonly (keyof PersistedUIState)[]

export type PairingLocalUiField = (typeof PAIRING_LOCAL_UI_FIELDS)[number]

// What a paired client actually receives over the UI RPCs, so reading a pairing-local field off a
// host response is a compile error rather than a silent undefined.
export type PairedUiState = Omit<PersistedUIState, PairingLocalUiField>

const PAIRING_LOCAL_UI_FIELD_SET: ReadonlySet<string> = new Set(PAIRING_LOCAL_UI_FIELDS)

// Accepts any object, not just Partial<PersistedUIState>: the ui.set seam passes the zod-inferred
// update type, whose optionality differs from the persisted shape.
export function omitPairingLocalUiFields<T extends object>(state: T): Omit<T, PairingLocalUiField> {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => !PAIRING_LOCAL_UI_FIELD_SET.has(key))
  ) as Omit<T, PairingLocalUiField>
}
