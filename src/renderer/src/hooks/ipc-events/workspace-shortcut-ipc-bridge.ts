import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/useWorkspaceBoardPanel'
import { activateTabNumberShortcut } from '@/lib/tab-number-shortcuts'
import { emitCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import { getVisibleWorktreeShortcutTargets } from '@/components/sidebar/visible-worktrees'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { deleteHoveredWorkspaceImmediately } from '@/components/sidebar/hovered-workspace-delete'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { useAppStore } from '../../store'
import { toggleAgentDashboardFromShortcut } from './agent-dashboard-command'
import { openNewWorkspaceFromShortcut } from './new-workspace-command'

export function registerWorkspaceShortcutIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onOpenQuickOpen(() => {
      const store = useAppStore.getState()
      if (store.activeView === 'terminal' && store.activeWorktreeId !== null) {
        store.openModal('quick-open')
      }
    })
  )

  unsubs.push(
    window.api.ui.onToggleQuickCommandsMenu(() => {
      window.dispatchEvent(new CustomEvent(TOGGLE_QUICK_COMMANDS_MENU_EVENT))
    })
  )

  unsubs.push(
    window.api.ui.onOpenNewWorkspace(() => {
      const store = useAppStore.getState()
      openNewWorkspaceFromShortcut(store)
    })
  )

  if (window.api.ui.onDeleteCurrentWorkspace) {
    unsubs.push(
      window.api.ui.onDeleteCurrentWorkspace(() => {
        if (isFloatingWorkspacePanelFocused()) {
          return
        }
        deleteHoveredWorkspaceImmediately(useAppStore.getState())
      })
    )
  }

  if (window.api.ui.onOpenWorkspaceBoard) {
    unsubs.push(
      window.api.ui.onOpenWorkspaceBoard(() => {
        const store = useAppStore.getState()
        if (store.activeView === 'settings') {
          return
        }
        store.setSidebarOpen(true)
        window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
      })
    )
  }

  if (window.api.ui.onToggleAgentDashboard) {
    unsubs.push(
      window.api.ui.onToggleAgentDashboard(() => {
        toggleAgentDashboardFromShortcut(useAppStore.getState(), () => {
          void window.api.dashboard.openPopout()
        })
      })
    )
  }

  unsubs.push(
    window.api.ui.onOpenTasks(() => {
      const store = useAppStore.getState()
      if (store.activeView === 'settings' || !store.repos.some((repo) => isGitRepoKind(repo))) {
        return
      }
      store.openTaskPage()
    })
  )

  unsubs.push(
    window.api.ui.onJumpToWorktreeIndex((index) => {
      const store = useAppStore.getState()
      // Why: while Cmd+J is open the digit chord means "activate recent row N" — main already
      // preventDefault'd it, so routing it here keeps digits out of the palette's search input.
      if (store.activeModal === 'worktree-palette') {
        emitCmdJRowIndexJump(index)
        return
      }
      if (store.activeView !== 'terminal') {
        return
      }
      const visibleTargets = getVisibleWorktreeShortcutTargets()
      const target = visibleTargets[index]
      if (target) {
        if (target.executionHostId) {
          activateAndRevealWorkspace(target.id, { executionHostId: target.executionHostId })
        } else {
          activateAndRevealWorkspace(target.id)
        }
      }
    })
  )

  unsubs.push(
    window.api.ui.onJumpToTabIndex((index) => {
      // Why: dropped while Cmd+J is open — never switch tabs behind the overlay.
      if (useAppStore.getState().activeModal === 'worktree-palette') {
        return
      }
      activateTabNumberShortcut(index)
    })
  )

  unsubs.push(
    window.api.ui.onWorktreeHistoryNavigate((direction) => {
      const store = useAppStore.getState()
      // Why: mirror button visibility — worktree history nav is only meaningful in the terminal view, so no-op elsewhere.
      if (store.activeView !== 'terminal') {
        return
      }
      if (direction === 'back') {
        store.goBackWorktree()
      } else {
        store.goForwardWorktree()
      }
    })
  )

  unsubs.push(
    window.api.ui.onToggleStatusBar(() => {
      const store = useAppStore.getState()
      store.setStatusBarVisible(!store.statusBarVisible)
    })
  )
}
