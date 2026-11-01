import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import { userWorkspaceSwitchCount } from '@/lib/workspace-switch-user-act'

const holdsTab = (state: AppState, worktreeId: string, tabId: string): boolean =>
  state.unifiedTabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId) ?? false

/**
 * Watches for the user picking a tab in the workspace while an action waits: a noted pick (a tab
 * click, even on the tab already shown), or a selection change. A change that closes the tab shown
 * at the action selects a neighbour on its own, so it is not a pick.
 */
export function watchUserTabPick(
  worktreeId: string,
  shownAtAction: string
): { picked: () => boolean; stop: () => void } {
  let picked = false
  const picksAtAction = userWorkspaceSwitchCount(worktreeId)
  let previous = useAppStore.getState()
  const stop = useAppStore.subscribe((state) => {
    const before = resolveWebSessionVisibleTabId(previous, worktreeId)
    const closedShown =
      holdsTab(previous, worktreeId, shownAtAction) && !holdsTab(state, worktreeId, shownAtAction)
    if (!closedShown && resolveWebSessionVisibleTabId(state, worktreeId) !== before) {
      picked = true
    }
    previous = state
  })
  return {
    picked: () => picked || userWorkspaceSwitchCount(worktreeId) !== picksAtAction,
    stop
  }
}
