import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import { useAppStore } from '../../../store/index'
import {
  ensureClientCreationActionAllowed,
  showClientCreationActionError
} from '@/lib/workspace/creation/surface-policy/client-creation-action-error'
import { createFloatingWorkspaceBrowserTab } from '@/components/floating-terminal/workspace/floating-workspace-tab-creation'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import type { TerminalActivationController } from '../tab-lifecycle/use-terminal-activation-actions'

export function handleTerminalWorkspaceBrowserShortcut(args: {
  event: KeyboardEvent
  activeWorktreeId: string
  floatingWorkspaceFocused: boolean
  controller: TerminalActivationController
  matchShortcut: (actionId: KeybindingActionId) => boolean
  notifyTerminalCapture: (actionId: KeybindingActionId) => void
}): boolean {
  const {
    event,
    activeWorktreeId,
    floatingWorkspaceFocused,
    controller,
    matchShortcut,
    notifyTerminalCapture
  } = args
  if (event.repeat) {
    return false
  }
  // Why: CodeMirror uses Ctrl/Cmd+Shift+B (type definition) and Ctrl/Cmd+Alt+B (implementation).
  if (event.target instanceof Element && event.target.closest('.cm-editor') !== null) {
    return false
  }
  if (matchShortcut('tab.newBrowser')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newBrowser')
    const browserWorkspaceId = floatingWorkspaceFocused
      ? FLOATING_TERMINAL_WORKTREE_ID
      : activeWorktreeId
    if (!ensureClientCreationActionAllowed(browserWorkspaceId, 'managed-browser')) {
      return true
    }
    if (floatingWorkspaceFocused) {
      void createFloatingWorkspaceBrowserTab(useAppStore.getState()).catch(
        showClientCreationActionError
      )
      return true
    }
    controller.handleNewBrowserTab()
    return true
  }
  if (matchShortcut('tab.newBrowserSplitRight')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newBrowserSplitRight')
    if (
      !floatingWorkspaceFocused &&
      ensureClientCreationActionAllowed(activeWorktreeId, 'managed-browser')
    ) {
      controller.handleNewBrowserTabSplitRight()
    }
    return true
  }
  return false
}
