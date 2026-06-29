import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { BrowserTab, TerminalTab } from '../../../shared/types'
import { createUntitledMarkdownFileWithTemplateSelection } from './create-untitled-markdown'
import { getConnectionId } from './connection-context'
import { detectLanguage } from './language-detect'
import type { AppState } from '@/store/types'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { translate } from '@/i18n/i18n'

type FloatingWorkspaceTerminalStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'createTab' | 'activateTab'
>

type FloatingWorkspaceBrowserStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'browserDefaultUrl' | 'createBrowserTab'
>

type FloatingWorkspaceMarkdownStore = Pick<AppState, 'activeGroupIdByWorktree' | 'openFile'>

export async function createFloatingWorkspaceTerminalTab(
  store: FloatingWorkspaceTerminalStore,
  shellOverride?: string
): Promise<TerminalTab | null> {
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]

  // Why: the floating workspace is a local scratchpad; a focused remote runtime
  // must not own its SSH/tmux terminals or prune them via session snapshots.
  const tab = store.createTab(FLOATING_TERMINAL_WORKTREE_ID, targetGroupId, shellOverride, {
    activate: false
  })
  store.activateTab(tab.id)
  focusTerminalTabSurface(tab.id)
  return tab
}

export async function createFloatingWorkspaceBrowserTab(
  store: FloatingWorkspaceBrowserStore
): Promise<BrowserTab | null> {
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const url = store.browserDefaultUrl ?? 'about:blank'

  // Why: browser tabs in the floating workspace share the same local-only
  // ownership rule as floating terminals.
  return store.createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, url, {
    title: translate('auto.lib.floating.workspace.tab.creation.f3785eddc2', 'New Browser Tab'),
    focusAddressBar: true,
    targetGroupId,
    browserRuntimeEnvironmentId: null
  })
}

export async function createFloatingWorkspaceMarkdownTab(
  store: FloatingWorkspaceMarkdownStore,
  markdownDirectory?: string | null
): Promise<void> {
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const floatingMarkdownDirectory =
    markdownDirectory ?? (await window.api.app.getFloatingMarkdownDirectory())
  if (!floatingMarkdownDirectory) {
    return
  }
  const fileInfo = await createUntitledMarkdownFileWithTemplateSelection(
    floatingMarkdownDirectory,
    FLOATING_TERMINAL_WORKTREE_ID,
    getConnectionId(FLOATING_TERMINAL_WORKTREE_ID) ?? undefined,
    { activeRuntimeEnvironmentId: null }
  )
  if (!fileInfo) {
    return
  }
  store.openFile(
    {
      ...fileInfo,
      language: detectLanguage(fileInfo.relativePath)
    },
    {
      preview: false,
      targetGroupId,
      suppressActiveRuntimeFallback: true
    }
  )
}
