import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { BrowserTab, TerminalTab } from '../../../shared/types'
import { createUntitledMarkdownFileWithTemplateSelection } from './create-untitled-markdown'
import { getConnectionId } from './connection-context'
import { detectLanguage } from './language-detect'
import type { AppState } from '@/store/types'
import {
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal
} from '@/runtime/web-runtime-session'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { translate } from '@/i18n/i18n'

type FloatingWorkspaceTerminalStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'createTab' | 'activateTab' | 'settings'
>

type FloatingWorkspaceBrowserStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'browserDefaultUrl' | 'createBrowserTab' | 'settings'
>

type FloatingWorkspaceMarkdownStore = Pick<AppState, 'activeGroupIdByWorktree' | 'openFile'>

export async function createFloatingWorkspaceTerminalTab(
  store: FloatingWorkspaceTerminalStore,
  shellOverride?: string
): Promise<TerminalTab | null> {
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const runtimeEnvironmentId = store.settings?.activeRuntimeEnvironmentId?.trim()
  if (
    await createWebRuntimeSessionTerminal({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      environmentId: runtimeEnvironmentId,
      targetGroupId,
      command: shellOverride,
      activate: true,
      selectWorktree: false
    })
  ) {
    return null
  }

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
  const runtimeEnvironmentId = store.settings?.activeRuntimeEnvironmentId?.trim()
  const url = store.browserDefaultUrl ?? 'about:blank'
  if (
    await createWebRuntimeSessionBrowserTab({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      environmentId: runtimeEnvironmentId,
      url,
      targetGroupId,
      selectWorktree: false
    })
  ) {
    return null
  }

  return store.createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, url, {
    title: translate("auto.lib.floating.workspace.tab.creation.f3785eddc2", "New Browser Tab"),
    focusAddressBar: true,
    targetGroupId
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
