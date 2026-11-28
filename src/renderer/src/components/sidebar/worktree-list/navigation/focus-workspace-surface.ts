import { useAppStore } from '@/store'
import { unfoldProjectsSectionForReveal } from './reveal-ancestors'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { activePaneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'
import {
  findRegisteredTerminalTab,
  focusRuntimeTerminalSurface
} from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'

/** Puts the keyboard in the active workspace's terminal or chat; false when neither takes it. */
export function focusActiveWorkspaceSurface(): boolean {
  const state = useAppStore.getState()
  const tab = state.activeWorktreeId ? state.getActiveTab(state.activeWorktreeId) : null
  if (
    state.activeView !== 'terminal' ||
    !state.activeWorktreeId ||
    !tab ||
    (tab.contentType !== 'terminal' && tab.contentType !== 'agent-session')
  ) {
    return false
  }
  const manager =
    tab.contentType === 'terminal'
      ? findRegisteredTerminalTab(tab.id, state.activeWorktreeId)?.tab.getManager()
      : null
  if (manager && !activePaneIsCoveredByNativeChat(manager)) {
    return focusRuntimeTerminalSurface(tab.id, null, state.activeWorktreeId)
  }
  requestNativeChatComposerFocus(tab.id)
  return true
}

export function focusActiveWorkspaceSurfaceFromSidebar(list: HTMLElement): void {
  if (focusActiveWorkspaceSurface()) {
    list.removeAttribute('data-keyboard-navigation')
  }
}

/** A folded Projects list is hidden and cannot take focus; unfold it, then focus once it lays out. */
export function focusProjects(list: () => HTMLElement | null): void {
  const focus = (): void => {
    const element = list()
    element?.focus()
    // A terminal that finishes mounting after this shortcut must not take the keys back.
    element?.setAttribute('data-keyboard-navigation', '')
  }
  const { collapsedGroups, toggleCollapsedGroup } = useAppStore.getState()
  if (unfoldProjectsSectionForReveal({ collapsedGroups, toggleGroup: toggleCollapsedGroup })) {
    requestAnimationFrame(focus)
  } else {
    focus()
  }
}
