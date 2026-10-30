import { toast } from 'sonner'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import type { KeybindingActionId } from '../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../shared/keybindings'
import { matchesRecentTabSwitcherChord } from '../../../shared/window-shortcut-policy'
import { useAppStore } from '../store'
import {
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  createFloatingWorkspaceTerminalTab,
  handleEmptyFloatingWorkspacePanelCloseShortcut,
  isEventTargetInsideFloatingWorkspacePanel,
  isFloatingWorkspacePanelFocused
} from '@/lib/floating-workspace-terminal-actions'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import {
  ensureClientCreationActionAllowed,
  showClientCreationActionError
} from '@/lib/client-creation-action-error'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { translate } from '@/i18n/i18n'
import { getKeybindingContext } from './terminal-workspace-model'
import { isAgentTerminalPreviewTarget } from './dashboard-popout/agent-terminal-preview-target'
import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import { getDetectionTargetIdentityForWorktree } from '@/lib/agent-detection-target-inventory'
import {
  launchAgentTabShortcut,
  launchFloatingWorkspaceAgentShortcut
} from './agent-tab-shortcut-launch'
import { handleTerminalWorkspaceEditorShortcut } from './terminal-workspace-editor-shortcuts'
import type { TerminalActivationController } from './use-terminal-activation-actions'

export function handleTerminalWorkspaceKeyDown(
  event: KeyboardEvent,
  controller: TerminalActivationController,
  shortcutPlatform: NodeJS.Platform
): void {
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
  if (!activeWorktreeId) {
    return
  }
  const context = getKeybindingContext(event.target)
  const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
  const matchShortcut = (actionId: KeybindingActionId): boolean =>
    keybindingMatchesAction(actionId, event, shortcutPlatform, keybindings, {
      context,
      terminalShortcutPolicy
    })
  const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
    if (context !== 'terminal' || terminalShortcutPolicy !== 'orca-first') {
      return
    }
    showTerminalShortcutCaptureNotification({
      actionId,
      platform: shortcutPlatform,
      keybindings
    })
  }
  if (!event.repeat && matchShortcut('tab.newTerminal')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newTerminal')
    if (floatingWorkspaceFocused) {
      void createFloatingWorkspaceTerminalTab(useAppStore.getState())
      return
    }
    handleNewTab()
    return
  }

  if (!event.repeat) {
    const agentShortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: floatingWorkspaceFocused ? FLOATING_TERMINAL_WORKTREE_ID : activeWorktreeId,
      keybindings,
      matchShortcut
    })
    if (agentShortcut.actionId) {
      event.preventDefault()
      notifyTerminalCapture(agentShortcut.actionId)
      if (floatingWorkspaceFocused) {
        // Why: this capture listener usually runs before the floating panel's own, so it routes there too.
        launchFloatingWorkspaceAgentShortcut(agentShortcut)
        return
      }
      const detectionTarget = getDetectionTargetIdentityForWorktree(
        useAppStore.getState(),
        activeWorktreeId
      )
      launchAgentTabShortcut(activeWorktreeId, agentShortcut, () => {
        const latest = useAppStore.getState()
        return (
          latest.activeWorktreeId === activeWorktreeId &&
          getDetectionTargetIdentityForWorktree(latest, activeWorktreeId) === detectionTarget
        )
      })
      return
    }
  }

  if (!event.repeat && matchShortcut('tab.reopenClosed')) {
    event.preventDefault()
    notifyTerminalCapture('tab.reopenClosed')
    try {
      useAppStore.getState().reopenClosedTab(activeWorktreeId)
    } catch (error) {
      showClientCreationActionError(error)
    }
    return
  }
  if (!event.repeat && matchShortcut('tab.newBrowser')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newBrowser')
    const browserWorkspaceId = floatingWorkspaceFocused
      ? FLOATING_TERMINAL_WORKTREE_ID
      : activeWorktreeId
    if (!ensureClientCreationActionAllowed(browserWorkspaceId, 'managed-browser')) {
      return
    }
    if (floatingWorkspaceFocused) {
      void createFloatingWorkspaceBrowserTab(useAppStore.getState()).catch(
        showClientCreationActionError
      )
      return
    }
    handleNewBrowserTab()
    return
  }
  if (!event.repeat && matchShortcut('tab.newBrowserSplitRight')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newBrowserSplitRight')
    if (
      !floatingWorkspaceFocused &&
      ensureClientCreationActionAllowed(activeWorktreeId, 'managed-browser')
    ) {
      handleNewBrowserTabSplitRight()
    }
    return
  }
  if (!event.repeat && mobileEmulatorEnabled && matchShortcut('tab.newSimulator')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newSimulator')
    if (!ensureClientCreationActionAllowed(activeWorktreeId, 'mobile-emulator')) {
      return
    }
    if (!floatingWorkspaceFocused) {
      handleNewSimulatorTab()
    }
    return
  }
  if (
    handleTerminalWorkspaceEditorShortcut({
      event,
      floatingWorkspaceFocused,
      matchShortcut,
      notifyTerminalCapture
    })
  ) {
    return
  }
  if (!event.repeat && matchShortcut('tab.newMarkdown')) {
    event.preventDefault()
    notifyTerminalCapture('tab.newMarkdown')
    if (floatingWorkspaceFocused) {
      void createFloatingWorkspaceMarkdownTab(useAppStore.getState()).catch((error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.Terminal.f0600556b3',
                'Failed to create untitled markdown file.'
              )
        )
      })
      return
    }
    void handleNewFile()
    return
  }
  const previewOwnsClose = isAgentTerminalPreviewTarget(event.target)
  if (
    !previewOwnsClose &&
    handleEmptyFloatingWorkspacePanelCloseShortcut(
      useAppStore.getState(),
      event,
      shortcutPlatform,
      keybindings
    )
  ) {
    return
  }
  if (!event.repeat && matchShortcut('tab.close')) {
    const floatingPanelOwnsEvent =
      isEventTargetInsideFloatingWorkspacePanel(event.target) || floatingWorkspaceFocused
    if (previewOwnsClose || floatingPanelOwnsEvent) {
      return
    }
    if (dispatchWorkspaceTabCommand({ type: 'close', context })) {
      event.preventDefault()
      notifyTerminalCapture('tab.close')
    }
    return
  }
  if (!event.repeat && matchShortcut('tab.closeAll')) {
    event.preventDefault()
    notifyTerminalCapture('tab.closeAll')
    handleCloseAllFiles()
    return
  }
  if (
    matchesRecentTabSwitcherChord(event, shortcutPlatform, keybindings, {
      context,
      terminalShortcutPolicy
    })
  ) {
    return
  }
  // Claim held repeats without switching again, or the newly active terminal receives the shortcut’s byte fallback.
  const claimTabSwitch = (): boolean => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    return !event.repeat
  }
  if (matchShortcut('tab.previousRecent')) {
    if (claimTabSwitch()) {
      dispatchWorkspaceTabCommand({ type: 'previous-recent' })
    }
    return
  }
  const switchSameTypeDirection = matchShortcut('tab.nextSameType')
    ? 1
    : matchShortcut('tab.previousSameType')
      ? -1
      : null
  const switchAllTypesDirection = matchShortcut('tab.nextAllTypes')
    ? 1
    : matchShortcut('tab.previousAllTypes')
      ? -1
      : null
  if (switchSameTypeDirection !== null || switchAllTypesDirection !== null) {
    if (!claimTabSwitch()) {
      return
    }
    notifyTerminalCapture(
      switchAllTypesDirection !== null
        ? switchAllTypesDirection === 1
          ? 'tab.nextAllTypes'
          : 'tab.previousAllTypes'
        : switchSameTypeDirection === 1
          ? 'tab.nextSameType'
          : 'tab.previousSameType'
    )
    dispatchWorkspaceTabCommand({
      type: 'switch',
      direction: switchAllTypesDirection ?? switchSameTypeDirection ?? 1,
      scope: switchAllTypesDirection !== null ? 'all-types' : 'same-type'
    })
  }
  const terminalTabDirection = matchShortcut('tab.nextTerminal')
    ? 1
    : matchShortcut('tab.previousTerminal')
      ? -1
      : null
  if (terminalTabDirection !== null && claimTabSwitch()) {
    dispatchWorkspaceTabCommand({
      type: 'switch',
      direction: terminalTabDirection,
      scope: 'terminal'
    })
  }
}
