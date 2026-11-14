import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { planMobileTerminalTabMount } from '@/components/terminal-pane/mounting/mobile-terminal-tab-mount'
import { useAppStore } from '../../store/index'

export function registerTerminalTabMountIpcBridge(unsubs: (() => void)[]): void {
  // Why: background-mount a mobile-subscribed tab's PTY without navigating the desktop (STA-1840).
  unsubs.push(
    window.api.ui.onRequestTerminalTabMount(({ worktreeId, tabId, ptyId }) => {
      if (!worktreeId) {
        return
      }
      // Why: synthetic pty handles need persisted-tab resolution; a miss must not mount every saved tab in a hidden worktree.
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
