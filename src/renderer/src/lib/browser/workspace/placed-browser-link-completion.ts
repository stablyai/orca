import { afterPendingEntityTabs } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { focusHttpLinkPage } from '../navigation/http-link-browser-placement'
import { revealFloatingWorkspacePanel } from '@/components/floating-terminal/floating-workspace-panel-reveal'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import type { OpenWorkspaceBrowserTabRequest } from './workspace-browser-tab-open'

/** Wait for the placed tab, report its client view, and reveal it only while the link still owns foreground intent. */
export async function completePlacedBrowserLink(
  request: OpenWorkspaceBrowserTabRequest,
  pageId: string,
  environmentId: string | null | undefined = request.expectedRuntimeEnvironmentId
): Promise<void> {
  if (!request.placementWorkspaceId) {
    return
  }
  const state = useAppStore.getState()
  const page = Object.values(state.browserPagesByWorkspace)
    .flat()
    .find(
      (page) =>
        page.id === pageId ||
        (state.remoteBrowserPageHandlesByPageId[page.id]?.remotePageId === pageId &&
          state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId === environmentId)
    )
  if (!page) {
    request.onLinkOutcome?.({ status: 'failed' })
    return
  }
  await new Promise<void>((resolve) =>
    afterPendingEntityTabs(request.placementWorkspaceId!, page.workspaceId, resolve)
  )
  const current = useAppStore.getState()
  const tab = current.unifiedTabsByWorktree[request.placementWorkspaceId]?.find(
    (tab) => tab.contentType === 'browser' && tab.entityId === page.workspaceId
  )
  if (!tab || request.linkContext?.isCurrentRequest?.() === false) {
    request.onLinkOutcome?.({ status: 'superseded' })
    return
  }
  request.onLinkOutcome?.({
    status: 'opened',
    result: {
      worktreeId: request.placementWorkspaceId,
      executionHostId: tab.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
      browserWorkspaceId: page.workspaceId,
      browserPageId: page.id,
      unifiedTabId: tab.id,
      groupId: tab.groupId
    }
  })
  if (request.focusOnCreate !== false && request.linkContext?.canReveal?.() !== false) {
    revealFloatingWorkspacePanel(current)
    focusHttpLinkPage(page.id)
  }
}
