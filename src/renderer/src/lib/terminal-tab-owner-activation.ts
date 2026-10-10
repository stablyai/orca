import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'

/**
 * Tells the paired server that owns `worktreeId` which tab and pane this client revealed, as a
 * tab-strip click does: the owner stores it as this client's selection and wakes a parked pane,
 * and a tab that has not reached this renderer yet is focused when it arrives.
 * Call after the local activation; navigating away before the tab arrives cancels that focus.
 * A workspace this client runs itself (local or SSH) needs no owner round trip.
 */
export function activateTerminalTabOnOwner(
  worktreeId: string,
  tabId: string,
  leafId: string | null
): void {
  const state = useAppStore.getState()
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return
  }
  void activateWebRuntimeSessionTab({
    worktreeId,
    tabId,
    environmentId,
    leafId,
    expectedCurrentLocalTabId: resolveWebSessionVisibleTabId(state, worktreeId)
  })
}
