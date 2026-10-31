import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { getTabIdToWorktreeId } from '../sidebar/worktree-agent-row-selectors'
import { useAppStore } from '../../store'

/**
 * True once for a chat mount the user's own switch to its workspace caused, so only that open may
 * start a stopped WSL distro (E9). A launch restore, reload or remount is false, and so is a chat
 * in another workspace mounting inside the switch window.
 */
export function takeNativeChatOpenWake(
  paneKey: string,
  chatSourceKey: string,
  tabsByWorktree: AppState['tabsByWorktree'] = useAppStore.getState().tabsByWorktree
): boolean {
  const tabId = parsePaneKey(paneKey)?.tabId
  const worktreeId = tabId ? getTabIdToWorktreeId(tabsByWorktree).get(tabId) : undefined
  return (
    worktreeId !== undefined &&
    takeRecentWorkspaceSwitchWake(worktreeId, `native-chat:${chatSourceKey}`)
  )
}
