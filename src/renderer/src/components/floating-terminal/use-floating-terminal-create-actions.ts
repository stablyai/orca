import { useCallback } from 'react'
import { toast } from 'sonner'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/editor/file-operations/create-untitled-markdown'
import { ensureClientCreationActionAllowed } from '@/lib/workspace/creation/surface-policy/client-creation-action-error'
import { openDocumentInFloatingWorkspace } from '@/components/floating-terminal/open-document-in-floating-workspace'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { FloatingWorkspaceChromeModel } from './use-floating-workspace-chrome-model'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { floatingWorkspaceHostExecutionFacts } from './floating-workspace-host-terminal'

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

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
    (shellOverride?: string, hostId?: ExecutionHostId) => {
      const tabId = createBrowserUuid()
      const executionFacts = floatingWorkspaceHostExecutionFacts(useAppStore.getState(), hostId)
      createTab(FLOATING_TERMINAL_WORKTREE_ID, activeGroup?.id, shellOverride, {
        id: tabId,
        ...(executionFacts ? { executionFacts } : {})
      })
      focusTerminalTabSurface(tabId)
    },
    [activeGroup, createTab]
  )

  const launchFloatingAgentOnHost = useCallback(
    (agent: TuiAgent, hostId: ExecutionHostId) => {
      const result = launchAgentInNewTabWithOutcome({
        requestId: createBrowserUuid(),
        agent,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        workspaceExecutionHostId: hostId,
        // Why: a paired server refuses chats in its floating workspace, so only a terminal starts.
        requestedSurface: 'terminal',
        ...(activeGroup ? { groupId: activeGroup.id } : {}),
        launchSource: 'tab_bar_quick_launch'
      })
      if (result && !('refused' in result) && result.surface.kind === 'local-terminal') {
        focusTerminalTabSurface(result.surface.tabId)
      }
    },
    [activeGroup]
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
          LOCAL_TARGET
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
        toast.error(
          extractIpcErrorMessage(
            error,
            translate(
              'components.toastFallbacks.markdownCreateFailed',
              'Failed to create untitled markdown file.'
            )
          )
        )
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
        openDocumentInFloatingWorkspace(openFile, document, {
          targetGroupId: activeGroup?.id
        })
      } catch (error) {
        toast.error(
          extractIpcErrorMessage(
            error,
            translate(
              'components.toastFallbacks.markdownOpenFailed',
              'Failed to open markdown file.'
            )
          )
        )
      }
    })()
  }, [activeGroup, openFile])

  return {
    activateFloatingItem,
    createFloatingTerminalTab,
    launchFloatingAgentOnHost,
    createFloatingBrowserTab,
    createFloatingMarkdownTab,
    openFloatingMarkdownTab
  }
}

export type FloatingTerminalCreateActions = ReturnType<typeof useFloatingTerminalCreateActions>
