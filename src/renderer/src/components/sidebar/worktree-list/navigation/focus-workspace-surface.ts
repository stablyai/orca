import { useAppStore } from '@/store'
import { unfoldProjectsSectionForReveal } from './reveal-ancestors'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { activePaneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'
import {
  findRegisteredTerminalTab,
  focusRuntimeTerminalSurface
} from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'

export function focusActiveWorkspaceSurfaceFromSidebar(list: HTMLElement): void {
  const state = useAppStore.getState()
  const tab = state.activeWorktreeId ? state.getActiveTab(state.activeWorktreeId) : null
  if (
    state.activeView !== 'terminal' ||
    !state.activeWorktreeId ||
    !tab ||
    (tab.contentType !== 'terminal' && tab.contentType !== 'agent-session')
  ) {
    return
  }
  const manager =
    tab.contentType === 'terminal'
      ? findRegisteredTerminalTab(tab.id, state.activeWorktreeId)?.tab.getManager()
      : null
  if (manager && !activePaneIsCoveredByNativeChat(manager)) {
    if (focusRuntimeTerminalSurface(tab.id, null, state.activeWorktreeId)) {
      list.removeAttribute('data-keyboard-navigation')
    }
    return
  }
  list.removeAttribute('data-keyboard-navigation')
  requestNativeChatComposerFocus(tab.id)
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
