import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'

/**
 * Tells the paired server that owns `worktreeId` which of its tabs this client revealed, as a
 * tab-strip click does. The owner stores it as this client's selection and wakes a parked pane;
 * the recorded focus intent focuses a tab that has not reached this renderer yet when it arrives.
 * A workspace this client runs itself (local or SSH) needs no owner round trip.
 */
export function activateTerminalTabOnOwner(worktreeId: string, tabId: string): void {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return
  }
  void activateWebRuntimeSessionTab({ worktreeId, tabId, environmentId })
}
