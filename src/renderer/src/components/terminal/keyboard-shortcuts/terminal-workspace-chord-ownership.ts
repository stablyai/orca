import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import { matchesRecentTabSwitcherChord } from '../../../../../shared/keybindings/window-shortcut-policy'
import { agentsScopeShortcutOwnsChord } from '@/hooks/app-commands/agents-shortcut-handlers'

/** Whether a surface other than the workspace tab handlers owns this chord, so those handlers leave it alone. */
export function chordOwnedOutsideWorkspaceTabs(
  matchShortcut: (actionId: KeybindingActionId) => boolean,
  ...recentTabSwitcherArgs: Parameters<typeof matchesRecentTabSwitcherChord>
): boolean {
  // Why: while focus is in Agents, its scope chords beat every tab-switching chord, recent-tab included.
  return (
    agentsScopeShortcutOwnsChord(matchShortcut) ||
    matchesRecentTabSwitcherChord(...recentTabSwitcherArgs)
  )
}
