import { useAppStore } from '@/store'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { focusRuntimeTerminalSurface } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'

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
  list.removeAttribute('data-keyboard-navigation')
  requestNativeChatComposerFocus(tab.id)
  if (tab.contentType === 'terminal') {
    focusRuntimeTerminalSurface(tab.id, null, state.activeWorktreeId)
  }
}
