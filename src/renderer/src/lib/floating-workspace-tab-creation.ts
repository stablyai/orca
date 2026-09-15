import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { BrowserTab } from '../../../shared/browser-workspace-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { createUntitledMarkdownFileWithTemplateSelection } from './create-untitled-markdown'
import { getConnectionId } from './connection-context'
import { detectLanguage } from './language-detect'
import type { AppState } from '@/store/types'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { translate } from '@/i18n/i18n'
import { assertClientCreationActionAvailable } from './client-creation-action-policy'
import { launchAgentInNewTab, type LaunchAgentInNewTabResult } from './launch-agent-in-new-tab'

type FloatingWorkspaceTerminalStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'createTab' | 'activateTab'
>

type FloatingWorkspaceAgentStore = Pick<AppState, 'activeGroupIdByWorktree'>

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
  assertClientCreationActionAvailable(
    store as AppState,
    FLOATING_TERMINAL_WORKTREE_ID,
    'managed-browser'
  )
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

// Why: `tab.newAgent`'s launch routing already treats FLOATING_TERMINAL_WORKTREE_ID as a first-class
// 'floating' workspace kind (see workspaceKindForWorktreeId) — this just gives the floating panel's
// own callers (keyboard shortcut, future UI) the same entry point terminal/browser/markdown use.
export function launchFloatingWorkspaceAgentTab(
  store: FloatingWorkspaceAgentStore,
  agent: TuiAgent
): LaunchAgentInNewTabResult {
  return launchAgentInNewTab({
    agent,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    groupId: store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID],
    launchSource: 'shortcut'
  })
}
