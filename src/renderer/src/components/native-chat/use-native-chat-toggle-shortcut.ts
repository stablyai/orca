import { usePluginCommands } from '@/store/plugin-panels'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { matchesRecentTabSwitcherChord } from '../../../../shared/window-shortcut-policy'
import {
  globalShortcutTargetYields,
  findPluginCommandForKeybinding
} from '@/lib/plugin-command-keybindings'
import { getKeybindingContext } from '../terminal-workspace-model'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/modifier-double-tap-detector'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { resolveNativeChatTabAgentEvidence } from '../tab-bar/native-chat-tab-agent-evidence'
import { canToggleNativeChat } from './native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { matchesNativeChatToggleShortcut } from './native-chat-shortcut'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { resolveKeyboardWorkspaceId } from '@/lib/floating-workspace-terminal-actions'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from './native-chat-leaf-routing'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export function resolveNativeChatToggleShortcutDetectedAgent({
  terminalTabId,
  terminalLayout,
  agentStatusByPaneKey
}: {
  terminalTabId: string
  terminalLayout?: TerminalLayoutSnapshot | null
  agentStatusByPaneKey: Record<string, { agentType?: AgentType }>
}): AgentType | null {
  const activeLeafId = resolveNativeChatActiveLayoutLeafId(terminalLayout)
  if (activeLeafId) {
    return agentStatusByPaneKey[`${terminalTabId}:${activeLeafId}`]?.agentType ?? null
  }
  if (!isNativeChatTabWideFallbackSafe(terminalLayout)) {
    return null
  }
  return (
    Object.entries(agentStatusByPaneKey).find(([paneKey]) =>
      paneKey.startsWith(`${terminalTabId}:`)
    )?.[1].agentType ?? null
  )
}

/** Toggles a workspace's focused agent-terminal tab between the terminal and native
 *  chat views via the keyboard. Gated to the surface the key press came from (main
 *  window or floating panel) so only one listener acts, and to agent terminals so
 *  the chord is inert on plain shells / non-terminal surfaces. */
export function useNativeChatToggleShortcut(worktreeId: string, isWorktreeActive: boolean): void {
  const pluginCommands = usePluginCommands()
  const pluginCommandsRef = useRef(pluginCommands)
  useLayoutEffect(() => {
    pluginCommandsRef.current = pluginCommands
  }, [pluginCommands])
  useEffect(() => {
    if (!isWorktreeActive) {
      return
    }
    const platform = getShortcutPlatform()
    const detector = new ModifierDoubleTapDetector()
    const attemptToggle = (
      e: KeyboardEvent,
      input: Parameters<typeof globalShortcutTargetYields>[0]
    ): void => {
      const state = useAppStore.getState()
      if (!matchesNativeChatToggleShortcut(input, platform, state.keybindings)) {
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
            pluginCommandsRef.current,
            input,
            platform,
            state.keybindings,
            Boolean(state.activeWorktreeId)
          ))
      ) {
        return
      }
      // Why: the floating panel and the main window can both be on screen; only the one the key
      // press came from toggles.
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
      // contentType gates out standalone structured (agent-session) tabs.
      if (!tab || tab.contentType !== 'terminal') {
        return
      }
      const terminalTab = (state.tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === tab.entityId
      )
      // Carry the agent identity (not just "an agent exists") so the chord stays
      // inert on unsupported agents (e.g. Gemini), matching the menu/header gate.
      // Pane keys are `${entityId}:${leafId}` — the backing terminal tab id, not
      // the unified tab id.
      const terminalLayout = state.terminalLayoutsByTabId[tab.entityId]
      const tabWideFallbackSafe = isNativeChatTabWideFallbackSafe(terminalLayout)
      const detectedAgent = resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: tab.entityId,
        terminalLayout,
        agentStatusByPaneKey: state.agentStatusByPaneKey
      })
      const titleFallbackAgent =
        tabWideFallbackSafe && terminalTab
          ? resolveNativeChatTabAgentEvidence(terminalTab, tab)
          : null
      if (
        !canToggleNativeChat({
          contentType: 'terminal',
          launchAgent: detectedAgent || !tabWideFallbackSafe ? null : terminalTab?.launchAgent,
          detectedAgent,
          resolvedAgent: detectedAgent ? null : titleFallbackAgent,
          nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
            getConnectionIdFromState(state, worktreeId)
          ),
          isChatViewMode: tab.viewMode === 'chat'
        })
      ) {
        return
      }
      state.toggleTabViewMode(tab.id)
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const onInput = (e: KeyboardEvent): void => {
      if (
        e.defaultPrevented ||
        e.repeat ||
        (e.target instanceof Element && e.target.closest('[data-shortcut-recorder-active]'))
      ) {
        detector.reset()
        return
      }
      const detected = detector.process(
        toModifierDoubleTapEvent({
          type: e.type === 'keyup' ? 'keyUp' : 'keyDown',
          key: e.key,
          code: e.code,
          meta: e.metaKey,
          control: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          isAutoRepeat: e.repeat
        }),
        Date.now()
      )
      if (e.type === 'keydown') {
        attemptToggle(
          e,
          detected
            ? {
                doubleTapModifier: detected.modifier,
                target: e.target,
                isComposing: e.isComposing,
                altGraph: e.getModifierState('AltGraph')
              }
            : e
        )
      }
    }
    const reset = (): void => detector.reset()
    addAppKeyListener('keydown', onInput)
    addAppKeyListener('keyup', onInput)
    window.addEventListener('blur', reset)
    window.addEventListener('focusin', reset)
    return () => {
      removeAppKeyListener('keydown', onInput)
      removeAppKeyListener('keyup', onInput)
      window.removeEventListener('blur', reset)
      window.removeEventListener('focusin', reset)
    }
  }, [worktreeId, isWorktreeActive])
}
