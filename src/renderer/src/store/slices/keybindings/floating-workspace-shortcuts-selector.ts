import type { AppState } from '../../types'

/** Read from the keybinding snapshot, never settings, so the predicate always matches the live map. */
export function selectFloatingWorkspaceShortcutsActive(
  state: Pick<AppState, 'keybindingSnapshot'>
): boolean {
  return state.keybindingSnapshot?.floatingWorkspaceShortcutsActive === true
}
