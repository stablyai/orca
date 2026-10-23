import { toast } from 'sonner'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import type { KeybindingActionId } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/tui-agent'
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
import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import { getDetectionTargetIdentityForWorktree } from '@/lib/agent-detection-target-inventory'
import {
  captureAgentTabLaunchContext,
  type AgentTabLaunchContext
} from './agent-tab-launch-context'
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
  if (!event.repeat && !floatingWorkspaceFocused && matchShortcut('tab.moveToNewWindow')) {
    const state = useAppStore.getState()
    const activeTab = state.getActiveTab(activeWorktreeId)
    if (activeTab?.contentType === 'terminal') {
      event.preventDefault()
      notifyTerminalCapture('tab.moveToNewWindow')
      void state.detachTerminalTab(activeTab.entityId)
    }
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
      const launchOrReport = (agent: TuiAgent | null, context?: AgentTabLaunchContext): void => {
        if (agent) {
          handleNewAgentTab(agent, context)
          return
        }
        toast.message(
          translate(
            'auto.components.Terminal.5b2c1a9e44',
            'No agent CLI detected — install one or pick a default agent in Settings.'
          )
        )
      }
      if (agentShortcut.pendingAgent) {
        const detectionTarget = getDetectionTargetIdentityForWorktree(
          useAppStore.getState(),
          activeWorktreeId
        )
        // Why: the tab belongs in the pane the shortcut was pressed in, not one focused while waiting.
        const launchContext = captureAgentTabLaunchContext(activeWorktreeId)
        void agentShortcut.pendingAgent.then((agent) => {
          // Why: a slow host probe must not open a tab in a workspace (or on a host) the user left.
          const latest = useAppStore.getState()
          if (
            latest.activeWorktreeId === activeWorktreeId &&
            getDetectionTargetIdentityForWorktree(latest, activeWorktreeId) === detectionTarget
          ) {
            launchOrReport(agent, launchContext)
          }
        })
      } else {
        launchOrReport(agentShortcut.agent)
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
  if (
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
    if (floatingPanelOwnsEvent) {
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
  // Why: a held tab chord is claimed on every repeat but switches once; an unclaimed repeat
  // would reach the newly active terminal as its own key (Cmd+Right as Ctrl+E).
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
