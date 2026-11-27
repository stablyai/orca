import { useEffect } from 'react'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from '../tab-lifecycle/use-terminal-activation-actions'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { isFloatingWorkspaceKeyTarget } from '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'

function isWorkspaceViewShown(state: AppState): boolean {
  return state.activeView === 'terminal' && !selectWorktreeCreationSurfaceShown(state)
}

export function useTerminalKeyboardShortcuts(controller: TerminalActivationController): void {
  const {
    activeWorktreeId,
    handleCloseAllFiles,
    handleNewBrowserTab,
    handleNewBrowserTabSplitRight,
    handleNewFile,
    handleNewSimulatorTab,
    handleNewTab,
    keybindings,
    mobileEmulatorEnabled,
    terminalShortcutPolicy
  } = controller
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    const onKeyDown = (event: KeyboardEvent): void => {
      // The workbench stays mounted behind other pages; do not act on tabs the user cannot see.
      if (
        isWorkspaceViewShown(useAppStore.getState()) ||
        isFloatingWorkspaceKeyTarget(event.target)
      ) {
        handleTerminalWorkspaceKeyDown(event, controller, shortcutPlatform)
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- preserve the original listener refresh contract across extraction.
  }, [
    activeWorktreeId,
    handleNewBrowserTab,
    handleNewBrowserTabSplitRight,
    handleNewSimulatorTab,
    handleNewFile,
    handleNewTab,
    handleCloseAllFiles,
    keybindings,
    mobileEmulatorEnabled,
    terminalShortcutPolicy
  ])
}
