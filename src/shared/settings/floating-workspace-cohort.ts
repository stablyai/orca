import type { GlobalSettings } from './global-settings-types'
import type { KeybindingActionId, KeybindingOverrides } from '../keybindings/types'
import { omitKeybindingActionOverrides } from '../keybindings/profile-defaults'

export const FLOATING_WORKSPACE_KEYBINDING_ACTION_IDS = [
  'floatingTerminal.toggle',
  'floatingWorkspace.maximize',
  'floatingWorkspace.minimize'
] as const satisfies readonly KeybindingActionId[]

const FLOATING_WORKSPACE_ACTION_ID_SET: ReadonlySet<string> = new Set(
  FLOATING_WORKSPACE_KEYBINDING_ACTION_IDS
)
const NO_INACTIVE_ACTION_IDS: readonly KeybindingActionId[] = []

type FloatingWorkspaceCohortSettings =
  | Partial<Pick<GlobalSettings, 'floatingWorkspaceInSettings' | 'floatingTerminalEnabled'>>
  | null
  | undefined

export function isFloatingWorkspaceKeybindingActionId(actionId: string): boolean {
  return FLOATING_WORKSPACE_ACTION_ID_SET.has(actionId)
}

/** Existing profiles only; frozen per profile, so every Settings surface agrees for a whole visit. */
export function isFloatingWorkspaceInSettings(settings: FloatingWorkspaceCohortSettings): boolean {
  return settings?.floatingWorkspaceInSettings === true
}

/** Fail-closed: floating shortcuts are live only for the existing cohort with the feature on. */
export function areFloatingWorkspaceShortcutsActive(
  settings: FloatingWorkspaceCohortSettings
): boolean {
  return settings?.floatingWorkspaceInSettings === true && settings.floatingTerminalEnabled === true
}

export function inactiveFloatingWorkspaceActionIds(active: boolean): readonly KeybindingActionId[] {
  return active ? NO_INACTIVE_ACTION_IDS : FLOATING_WORKSPACE_KEYBINDING_ACTION_IDS
}

/** Inactive floating overrides must not claim chords; the file's own sections stay untouched. */
export function omitInactiveFloatingWorkspaceOverrides(
  overrides: KeybindingOverrides,
  active: boolean
): KeybindingOverrides {
  return omitKeybindingActionOverrides(overrides, inactiveFloatingWorkspaceActionIds(active))
}
