import { toast } from 'sonner'
import type { KeybindingActionId } from '../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../shared/keybindings'
import { matchesRecentTabSwitcherChord } from '../../../shared/window-shortcut-policy'
import { useAppStore } from '../store'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '../hooks/ipc-tab-switch'
import {
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  createFloatingWorkspaceTerminalTab,
  handleEmptyFloatingWorkspacePanelCloseShortcut,
  isEventTargetInsideFloatingWorkspacePanel,
  isFloatingWorkspacePanelFocused,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import {
  ensureClientCreationActionAllowed,
  showClientCreationActionError
} from '@/lib/client-creation-action-error'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { translate } from '@/i18n/i18n'
import { getKeybindingContext } from './terminal-workspace-model'
import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
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
    handleCloseBrowserTab,
    handleCloseFile,
    handleNewAgentTab,
    handleNewBrowserTab,
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
      activeWorktreeId,
      keybindings,
      matchShortcut
    })
    if (agentShortcut.actionId) {
      event.preventDefault()
      notifyTerminalCapture(agentShortcut.actionId)
      if (agentShortcut.agent) {
        handleNewAgentTab(agentShortcut.agent)
      } else {
        toast.message(
          translate(
            'auto.components.Terminal.5b2c1a9e44',
            'No agent CLI detected — install one or pick a default agent in Settings.'
          )
        )
      }
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
  if (handleEmptyFloatingWorkspacePanelCloseShortcut(event, shortcutPlatform, keybindings)) {
    return
  }
  if (!event.repeat && matchShortcut('tab.close')) {
    const floatingPanelOwnsEvent =
      isEventTargetInsideFloatingWorkspacePanel(event.target) || floatingWorkspaceFocused
    if (floatingPanelOwnsEvent) {
      return
    }
    const state = useAppStore.getState()
    if (state.activeTabType === 'terminal' && context === 'terminal') {
      return
    }
    event.preventDefault()
    notifyTerminalCapture('tab.close')
    if (state.activeTabType === 'editor' && state.activeFileId) {
      handleCloseFile(state.activeFileId)
    } else if (state.activeTabType === 'browser' && state.activeBrowserTabId) {
      handleCloseBrowserTab(state.activeBrowserTabId)
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
  if (!event.repeat && matchShortcut('tab.previousRecent')) {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    handleSwitchRecentTab()
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
  if (!event.repeat && (switchSameTypeDirection !== null || switchAllTypesDirection !== null)) {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    notifyTerminalCapture(
      switchAllTypesDirection !== null
        ? switchAllTypesDirection === 1
          ? 'tab.nextAllTypes'
          : 'tab.previousAllTypes'
        : switchSameTypeDirection === 1
          ? 'tab.nextSameType'
          : 'tab.previousSameType'
    )
    if (floatingWorkspaceFocused) {
      switchFloatingWorkspaceTab(
        useAppStore.getState(),
        switchAllTypesDirection ?? switchSameTypeDirection ?? 1,
        switchAllTypesDirection !== null ? 'all-types' : 'same-type'
      )
    } else if (switchAllTypesDirection !== null) {
      handleSwitchTabAcrossAllTypes(switchAllTypesDirection)
    } else {
      handleSwitchTab(switchSameTypeDirection ?? 1)
    }
  }
  const terminalTabDirection = matchShortcut('tab.nextTerminal')
    ? 1
    : matchShortcut('tab.previousTerminal')
      ? -1
      : null
  if (!event.repeat && terminalTabDirection !== null) {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (floatingWorkspaceFocused) {
      switchFloatingWorkspaceTab(useAppStore.getState(), terminalTabDirection, 'terminal')
    } else {
      handleSwitchTerminalTab(terminalTabDirection)
    }
  }
}
