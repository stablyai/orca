import { useCallback } from 'react'
import { toast } from 'sonner'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import { getConnectionId } from '@/lib/connection-context'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { ensureClientCreationActionAllowed } from '@/lib/client-creation-action-error'
import { openDocumentInFloatingWorkspace } from '@/lib/open-document-in-floating-workspace'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useFloatingWorkspaceId, useFloatingWorkspaceHost } from '@/lib/floating-workspace-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { floatingWorkspaceEnvironmentId } from '../../../../shared/floating-workspace-id'
import type { FloatingWorkspaceChromeModel } from './use-floating-workspace-chrome-model'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'

const LOCAL_RUNTIME_SETTINGS = { activeRuntimeEnvironmentId: null } as const

type FloatingTerminalCreateActionsInput = Pick<
  FloatingTerminalPanelStoreState,
  | 'activateTab'
  | 'setActiveTab'
  | 'createTab'
  | 'createBrowserTab'
  | 'browserDefaultUrl'
  | 'openFile'
> &
  Pick<FloatingWorkspaceChromeModel, 'activeGroup' | 'groupTabs'> &
  Pick<FloatingTerminalPanelLocalState, 'markdownCwd'>

export function useFloatingTerminalCreateActions({
  activateTab,
  setActiveTab,
  createTab,
  createBrowserTab,
  browserDefaultUrl,
  openFile,
  activeGroup,
  groupTabs,
  markdownCwd
}: FloatingTerminalCreateActionsInput) {
  const worktreeId = useFloatingWorkspaceId()
  const activateFloatingItem = useCallback(
    (visibleId: string) => {
      const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
      if (!item) {
        return
      }
      activateTab(item.id)
      if (item.contentType === 'terminal') {
        setActiveTab(item.entityId)
        focusTerminalTabSurface(item.entityId)
      } else if (item.contentType === 'browser') {
        const workspace = useAppStore
          .getState()
          .browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === item.entityId)
        if (workspace?.activePageId && window.api?.browser) {
          void window.api.browser.notifyActiveTabChanged({ browserPageId: workspace.activePageId })
        }
      }
    },
    [activateTab, groupTabs, setActiveTab, worktreeId]
  )

  const createFloatingTerminalTab = useCallback(
    (shellOverride?: string) => {
      const tab = createTab(worktreeId, activeGroup?.id, shellOverride)
      focusTerminalTabSurface(tab.id)
    },
    [activeGroup, createTab, worktreeId]
  )

  const createFloatingBrowserTab = useCallback(() => {
    if (!ensureClientCreationActionAllowed(worktreeId, 'managed-browser')) {
      return
    }
    const url = browserDefaultUrl ?? 'about:blank'
    createBrowserTab(worktreeId, url, {
      title: translate(
        'auto.components.floating.terminal.FloatingTerminalPanel.8b14ba6c17',
        'New Browser Tab'
      ),
      focusAddressBar: true,
      targetGroupId: activeGroup?.id,
      browserRuntimeEnvironmentId: floatingWorkspaceEnvironmentId(worktreeId)
    })
  }, [activeGroup, browserDefaultUrl, createBrowserTab, worktreeId])

  const createFloatingMarkdownTab = useCallback(() => {
    if (!markdownCwd) {
      return
    }
    void (async () => {
      try {
        const fileInfo = await createUntitledMarkdownFileWithTemplateSelection(
          markdownCwd,
          FLOATING_TERMINAL_WORKTREE_ID,
          getConnectionId(FLOATING_TERMINAL_WORKTREE_ID) ?? undefined,
          LOCAL_RUNTIME_SETTINGS
        )
        if (!fileInfo) {
          return
        }
        useFloatingWorkspaceHost.getState().selectHost(null)
        openFile(fileInfo, {
          preview: false,
          targetGroupId: floatingWorkspaceEnvironmentId(worktreeId) ? undefined : activeGroup?.id,
          suppressActiveRuntimeFallback: true
        })
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, 'Failed to create untitled markdown file.'))
      }
    })()
  }, [activeGroup, markdownCwd, openFile, worktreeId])

  const openFloatingMarkdownTab = useCallback(() => {
    void (async () => {
      try {
        const document = await window.api.app.pickFloatingMarkdownDocument()
        if (!document) {
          return
        }
        useFloatingWorkspaceHost.getState().selectHost(null)
        openDocumentInFloatingWorkspace(openFile, document, {
          targetGroupId: floatingWorkspaceEnvironmentId(worktreeId) ? undefined : activeGroup?.id
        })
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, 'Failed to open markdown file.'))
      }
    })()
  }, [activeGroup, openFile, worktreeId])

  return {
    activateFloatingItem,
    createFloatingTerminalTab,
    createFloatingBrowserTab,
    createFloatingMarkdownTab,
    openFloatingMarkdownTab
  }
}

export type FloatingTerminalCreateActions = ReturnType<typeof useFloatingTerminalCreateActions>
