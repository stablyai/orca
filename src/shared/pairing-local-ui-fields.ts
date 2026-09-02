import type { PersistedUIState } from './persisted-ui-state-types'

// UI state each side of a pairing owns for itself. These fields describe a client's own view —
// which workspaces it hides, what order it puts repos and host sections in — and are keyed to hosts
// only that side knows about, so a value copied across the boundary in either direction overwrites
// the receiver's answer with one computed for somebody else. They must be stripped on the way to a
// host (ui.set) and pinned to the local value on the way back (ui.get).
export const PAIRING_LOCAL_UI_FIELDS = [
  // Its hostKey names authorities only the writing client can resolve — a paired
  // client's `desktop` is a different machine — and old hosts reject the unknown key.
  'automationHostFilter',
  'hideWorkspacesFromOtherDevices',
  'manualRepoOrder',
  'workspaceHostOrder',
  // Agent View filters and presentation belong to each client's host catalog and viewport.
  'agentsVisibleHostIds',
  'agentsFilterRepoIds',
  'agentsShowChildAgents',
  'agentsCompactMode',
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
