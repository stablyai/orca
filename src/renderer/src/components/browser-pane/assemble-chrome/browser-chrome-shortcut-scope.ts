import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'

/** Which chrome chords (address bar, find, reload, history) a browser pane answers. */
export function resolveBrowserChromeShortcutScope({
  isActive,
  isWorktreeFocused,
  isFloatingWorkspace,
  focusedGroupId,
  groupId
}: {
  isActive: boolean
  /** False for a grid view member that is on screen but does not own keyboard focus. */
  isWorktreeFocused: boolean
  isFloatingWorkspace: boolean
  focusedGroupId: string | undefined
  groupId: string | undefined
}): BrowserChromeShortcutScope {
  // Why: 'focused' answers chords from anywhere in the window, so only the focused workspace's
  // browser may hold it; another visible grid cell would steal Cmd/Ctrl+L and Cmd/Ctrl+F.
  if (!isActive || !isWorktreeFocused) {
    return 'inactive'
  }
  // Why: 'focused' means the main window's focused split, so a floating browser answers only its own chords.
  if (isFloatingWorkspace || focusedGroupId === undefined) {
    return 'owned-target'
  }
  return groupId === focusedGroupId ? 'focused' : 'inactive'
}
