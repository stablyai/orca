import { useEffect } from 'react'
import { keybindingMatchesAction } from '../../../../shared/keybindings/matching'
import { matchesRecentTabSwitcherChord } from '../../../../shared/keybindings/window-shortcut-policy'
import {
  globalShortcutTargetYields,
  findPluginCommandForKeybinding
} from '@/lib/plugins/commands/plugin-command-keybindings'
import { getKeybindingContext } from '../terminal/workbench/terminal-workspace-model'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { resolveKeyboardWorkspaceId } from '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'
import { canToggleNativeChat } from '../../../../shared/native-chat/native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '../../../../shared/native-chat/transcript/messages/native-chat-transcript-readability'
import { useAppStore } from '../../store'
import { usePluginCommands } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

/** Toggle the live agent map on the key event's originating workspace surface.
 *  The map renders the same session chat shows, so it gates on the same availability rule. */
export function useAgentMapToggleShortcut(worktreeId: string, isWorktreeActive: boolean): void {
  const pluginCommands = usePluginCommands()
  useEffect(() => {
    if (!isWorktreeActive) {
      return
    }
    const platform = getShortcutPlatform()
    // The raw KeyboardEvent carries `target`/`isComposing` the plain KeybindingInput lacks.
    const attemptToggle = (e: KeyboardEvent): void => {
      const input = e
      const state = useAppStore.getState()
      if (!keybindingMatchesAction('terminal.toggleAgentMap', input, platform, state.keybindings)) {
        return
      }
      const context = getKeybindingContext(e.target)
      const options = { context, terminalShortcutPolicy: state.settings?.terminalShortcutPolicy }
      if (
        matchesRecentTabSwitcherChord(input, platform, state.keybindings, options) ||
        (context === 'app' &&
          !input.isComposing &&
          input.key !== 'Process' &&
          !globalShortcutTargetYields(input, platform, state.keybindings, options) &&
          findPluginCommandForKeybinding(
            pluginCommands,
            input,
            platform,
            state.keybindings,
            Boolean(state.activeWorktreeId)
          ))
      ) {
        return
      }
      if (resolveKeyboardWorkspaceId(e.target, state.activeWorktreeId) !== worktreeId) {
        return
      }
      const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
      const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === activeGroupId)
      if (!group?.activeTabId) {
        return
      }
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === group.activeTabId
      )
      if (!tab || tab.contentType !== 'terminal') {
        return
      }
      const terminalTab = (state.tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === tab.entityId
      )
      // Exiting the map is always allowed; entering needs a supported, readable agent.
      if (tab.viewMode !== 'map') {
        if (
          !canToggleNativeChat({
            contentType: 'terminal',
            launchAgent: terminalTab?.launchAgent ?? null,
            detectedAgent: null,
            resolvedAgent: null,
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              getConnectionIdFromState(state, worktreeId)
            ),
            isChatViewMode: false
          })
        ) {
          return
        }
      }
      state.setTabViewMode(tab.id, tab.viewMode === 'map' ? 'terminal' : 'map')
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const onInput = (e: KeyboardEvent): void => {
      if (
        e.defaultPrevented ||
        e.repeat ||
        (e.target instanceof Element && e.target.closest('[data-shortcut-recorder-active]'))
      ) {
        return
      }
      if (e.type === 'keydown') {
        attemptToggle(e)
      }
    }
    addAppKeyListener('keydown', onInput)
    return () => {
      removeAppKeyListener('keydown', onInput)
    }
  }, [worktreeId, isWorktreeActive, pluginCommands])
}
