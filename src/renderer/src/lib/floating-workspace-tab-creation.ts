import { getSelectedFloatingWorkspaceId, useFloatingWorkspaceHost } from './floating-workspace-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { floatingWorkspaceEnvironmentId } from '../../../shared/floating-workspace-id'
import type { BrowserTab } from '../../../shared/browser-workspace-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { createUntitledMarkdownFileWithTemplateSelection } from './create-untitled-markdown'
import { getConnectionId } from './connection-context'
import { detectLanguage } from './language-detect'
import type { AppState } from '@/store/types'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { translate } from '@/i18n/i18n'
import { assertClientCreationActionAvailable } from './client-creation-action-policy'

type FloatingWorkspaceTerminalStore = Pick<AppState, 'activeGroupIdByWorktree' | 'createTab'>

type FloatingWorkspaceBrowserStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'browserDefaultUrl' | 'createBrowserTab'
>

type FloatingWorkspaceMarkdownStore = Pick<AppState, 'activeGroupIdByWorktree' | 'openFile'>

export async function createFloatingWorkspaceTerminalTab(
  store: FloatingWorkspaceTerminalStore,
  shellOverride?: string,
  /** A split group's own "+"; omitted, the tab lands in the focused group. */
  groupId?: string
): Promise<TerminalTab | null> {
  const targetGroupId = groupId ?? store.activeGroupIdByWorktree[getSelectedFloatingWorkspaceId()]

  // Only the floating host selector can change this owner; sidebar focus cannot.
  const tab = store.createTab(getSelectedFloatingWorkspaceId(), targetGroupId, shellOverride)
  focusTerminalTabSurface(tab.id)
  return tab
}

export async function createFloatingWorkspaceBrowserTab(
  store: FloatingWorkspaceBrowserStore
): Promise<BrowserTab | null> {
  assertClientCreationActionAvailable(
    store as AppState,
    getSelectedFloatingWorkspaceId(),
    'managed-browser'
  )
  const targetGroupId = store.activeGroupIdByWorktree[getSelectedFloatingWorkspaceId()]
  const url = store.browserDefaultUrl ?? 'about:blank'

  // Browsers follow the selected floating host, independently of sidebar focus.
  return store.createBrowserTab(getSelectedFloatingWorkspaceId(), url, {
    title: translate('auto.lib.floating.workspace.tab.creation.f3785eddc2', 'New Browser Tab'),
    focusAddressBar: true,
    targetGroupId,
    browserRuntimeEnvironmentId: floatingWorkspaceEnvironmentId(getSelectedFloatingWorkspaceId())
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
  useFloatingWorkspaceHost.getState().selectHost(null)
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
