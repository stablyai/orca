import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'

const EDITOR_SURFACES = [
  '.monaco-editor textarea',
  '.rich-markdown-editor[contenteditable="true"]',
  '.markdown-preview'
]
const FALLBACK_SURFACES = ['.xterm-helper-textarea', '.monaco-editor textarea']

/** Moves focus from a sidebar panel back to the content of the active tab. */
export function focusActiveTabSurface(): void {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return
  }
  if (state.activeTabType === 'terminal') {
    const tabId = state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId
    if (tabId) {
      focusTerminalTabSurface(tabId, state.terminalLayoutsByTabId[tabId]?.activeLeafId ?? null)
      return
    }
  }
  if (state.activeTabType === 'browser') {
    const pageId = (state.browserTabsByWorktree[worktreeId] ?? []).find(
      (workspace) => workspace.id === state.activeBrowserTabId
    )?.activePageId
    if (pageId) {
      requestBrowserFocus({ pageId, target: 'webview' })
      return
    }
  }
  const selectors = state.activeTabType === 'editor' ? EDITOR_SURFACES : FALLBACK_SURFACES
  for (const selector of selectors) {
    const target = document.querySelector<HTMLElement>(selector)
    target?.focus()
    if (target && target.contains(document.activeElement)) {
      return
    }
  }
}
