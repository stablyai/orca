import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import type { TypeCyclableTab } from '../terminal/tab-type-cycle'

const EDITOR_INPUT_SELECTOR =
  '.monaco-editor textarea, .monaco-editor .native-edit-context, [contenteditable="true"]'

/**
 * Moves the keyboard into a tab that the switcher opened in another pane. Activation only marks
 * that pane as focused: an editor already on screen there does not take the focus, and an editor
 * that mounts with the switch takes it only from the page body.
 */
export function focusTabInOtherPane(
  worktreeId: string,
  tab: TypeCyclableTab,
  paneBefore: string | undefined
): void {
  const pane = getPaneAfterSwitch(worktreeId, paneBefore)
  if (!pane) {
    return
  }
  if (tab.type === 'terminal') {
    focusTerminalTabSurface(tab.id)
    return
  }
  if (tab.type === 'agent-session') {
    if (tab.tabId) {
      requestNativeChatComposerFocus(tab.tabId)
    }
    return
  }
  if (tab.type === 'browser') {
    const pageId = useAppStore
      .getState()
      .browserTabsByWorktree[worktreeId]?.find(
        (browserTab) => browserTab.id === tab.id
      )?.activePageId
    if (pageId) {
      requestBrowserFocus({ pageId, target: 'webview' })
    }
    return
  }
  focusPaneEditor(pane)
}

/**
 * An All workspaces row opens through Cmd+J's path, which expects an editor to take the focus
 * when it mounts. An editor that stays mounted, in another pane or behind another workspace or
 * view, does not. `paneBefore` is undefined when no pane of this workspace had the focus.
 */
export function focusEditorInOtherPane(worktreeId: string, paneBefore: string | undefined): void {
  const pane = getPaneAfterSwitch(worktreeId, paneBefore)
  if (pane) {
    focusPaneEditor(pane)
  }
}

function getPaneAfterSwitch(worktreeId: string, paneBefore: string | undefined): string | null {
  const pane = useAppStore.getState().activeGroupIdByWorktree[worktreeId]
  return pane && pane !== paneBefore ? pane : null
}

function focusPaneEditor(pane: string): void {
  // Why: the old pane stays on screen, so its field would keep the keys while the editor loads.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
  requestAnimationFrame(() => {
    const input = document
      .querySelector(`[data-tab-group-body-id="${CSS.escape(pane)}"]`)
      ?.querySelector(EDITOR_INPUT_SELECTOR)
    if (input instanceof HTMLElement) {
      input.focus()
    }
  })
}
