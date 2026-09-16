import { useCallback } from 'react'
import { toast } from 'sonner'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import { getConnectionId } from '@/lib/connection-context'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { ensureClientCreationActionAllowed } from '@/lib/client-creation-action-error'
import { openMarkdownDocumentInFloatingWorkspace } from '@/lib/open-markdown-in-floating-workspace'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { FloatingTerminalPanelItems } from './use-floating-terminal-panel-items'
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
  Pick<FloatingTerminalPanelItems, 'activeGroup' | 'groupTabs'> &
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
          .browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
            (tab) => tab.id === item.entityId
          )
        if (workspace?.activePageId && window.api?.browser) {
          void window.api.browser.notifyActiveTabChanged({ browserPageId: workspace.activePageId })
        }
      }
    },
    [activateTab, groupTabs, setActiveTab]
  )

  const createFloatingTerminalTab = useCallback(
    (shellOverride?: string) => {
      const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, activeGroup?.id, shellOverride, {
        activate: false
      })
      activateTab(tab.id)
      focusTerminalTabSurface(tab.id)
    },
    [activateTab, activeGroup, createTab]
  )

  const createFloatingBrowserTab = useCallback(() => {
    if (!ensureClientCreationActionAllowed(FLOATING_TERMINAL_WORKTREE_ID, 'managed-browser')) {
      return
    }
    const url = browserDefaultUrl ?? 'about:blank'
    createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, url, {
      title: translate(
        'auto.components.floating.terminal.FloatingTerminalPanel.8b14ba6c17',
        'New Browser Tab'
      ),
      focusAddressBar: true,
      targetGroupId: activeGroup?.id,
      browserRuntimeEnvironmentId: null
    })
  }, [activeGroup, browserDefaultUrl, createBrowserTab])

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
        openFile(fileInfo, {
          preview: false,
          targetGroupId: activeGroup?.id,
          suppressActiveRuntimeFallback: true
        })
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, 'Failed to create untitled markdown file.'))
      }
    })()
  }, [activeGroup, markdownCwd, openFile])

  const openFloatingMarkdownTab = useCallback(() => {
    void (async () => {
      try {
        const document = await window.api.app.pickFloatingMarkdownDocument()
        if (!document) {
          return
        }
        openMarkdownDocumentInFloatingWorkspace(openFile, document, {
          targetGroupId: activeGroup?.id
        })
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, 'Failed to open markdown file.'))
      }
    })()
  }, [activeGroup, openFile])

  return {
    activateFloatingItem,
    createFloatingTerminalTab,
    createFloatingBrowserTab,
    createFloatingMarkdownTab,
    openFloatingMarkdownTab
  }
}

export type FloatingTerminalCreateActions = ReturnType<typeof useFloatingTerminalCreateActions>
