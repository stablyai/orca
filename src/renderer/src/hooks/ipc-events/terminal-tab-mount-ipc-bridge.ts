import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { planMobileTerminalTabMount } from '@/lib/mobile-terminal-tab-mount'
import { useAppStore } from '../../store'

/** Mount a subscribed terminal without navigating the desktop. */
export function registerTerminalTabMountIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onRequestTerminalTabMount(({ worktreeId, tabId, ptyId }) => {
      if (!worktreeId) {
        return
      }
      // Synthetic handles need exact persisted-tab resolution, never a whole-workspace mount.
      const mount = planMobileTerminalTabMount(
        useAppStore.getState(),
        {
          worktreeId,
          ...(tabId ? { tabId } : {}),
          ...(ptyId ? { ptyId } : {})
        },
        {
          isTabMounted: (tabId, targetWorktreeId) =>
            hasRegisteredRuntimeTerminalTab(tabId, targetWorktreeId)
        }
      )
      if (mount) {
        requestBackgroundTerminalWorktreeMount(mount)
      }
    })
  )
}
