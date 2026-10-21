import { basename } from '@/lib/path'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import type { AppState } from '@/store/types'
import type { CreateBrowserTabOptions } from '@/store/slices/browser/browser-slice-contract'
import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import type { BrowserPageDocLocation } from '../../../shared/browser-workspace-types'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import { findWorkspaceShowingPage } from './workspace-file-preview-page'
import { getBrowserPageRuntimeEnvironmentId } from '@/components/browser-pane/describe-page/browser-page-url-display'
import { refreshLocalHtmlPreview } from '@/components/browser-pane/navigate/local-html-preview-freshness'
import { webviewRegistry } from '@/components/browser-pane/host-guest/webview-registry'
import type { WorkspaceFilePreviewPlan } from './file-preview'

export function openFilePreviewTab(
  state: AppState,
  params: { filePath: string; worktreeId: string; activate: boolean; clientLocal?: boolean },
  plan: Exclude<WorkspaceFilePreviewPlan, { status: 'unsupported' }>,
  placement?: Pick<CreateBrowserTabOptions, 'targetGroupId' | 'split'>
): void {
  const docLocation: BrowserPageDocLocation | null =
    plan.status === 'doc-preview'
      ? { kind: 'workspace-doc', worktreeId: params.worktreeId, filePath: params.filePath }
      : null
  const inferredRuntimeEnvironmentId = runtimeEnvironmentIdUnlessTwin(state, params.worktreeId)
  const previewRuntimeEnvironmentId = params.clientLocal ? null : inferredRuntimeEnvironmentId
  const existing = findWorkspaceShowingPage(
    state,
    params.worktreeId,
    (page) =>
      plan.status === 'browser-tab'
        ? !page.docLocation &&
          page.url === plan.url &&
          getBrowserPageRuntimeEnvironmentId(page, inferredRuntimeEnvironmentId) ===
            previewRuntimeEnvironmentId
        : browserPageDocLocationsEqual(page.docLocation ?? null, docLocation),
    placement?.targetGroupId
  )
  if (existing) {
    const webview = plan.status === 'browser-tab' ? webviewRegistry.get(existing.pageId) : null
    if (webview) {
      void refreshLocalHtmlPreview(webview, params.filePath)
    }
    if (
      !params.activate ||
      !activateBrowserWorkspaceTab({
        worktreeId: params.worktreeId,
        ...existing
      })
    ) {
      state.setActiveBrowserTab(existing.workspaceId)
      state.setActiveBrowserPage(existing.workspaceId, existing.pageId)
    }
    return
  }
  state.createBrowserTab(
    params.worktreeId,
    plan.status === 'browser-tab' ? plan.url : ORCA_BROWSER_BLANK_URL,
    {
      title:
        plan.status === 'browser-tab' ? plan.title : basename(params.filePath) || params.filePath,
      ...placement,
      // Document grants belong to this desktop even when the workspace is remote.
      ...(docLocation ? { docLocation, browserRuntimeEnvironmentId: null } : {}),
      ...(params.clientLocal ? { browserRuntimeEnvironmentId: null } : {}),
      activate: params.activate
    }
  )
}
