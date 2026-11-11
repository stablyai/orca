import type { BrowserSliceGet } from '../browser-slice-contract'
import { findWorkspace } from '../pages/browser-page-records'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/browser/workspace/ssh-workspace-browser-route-eligibility'
import { resolveBrowserPagePartition } from '@/components/browser-pane/host-guest/browser-page-partition'
import {
  sshWorkspaceBrowserRouteKey,
  verifiedPartitionByRoute
} from '@/components/browser-pane/ssh-workspace-browser-verified-routes'
import {
  replacePersistentWebview,
  webviewRegistry
} from '@/components/browser-pane/host-guest/webview-registry'
import { admitBrowserPageMount } from '@/components/browser-pane/host-guest/browser-page-mount-admission'

export function reconcileBrowserProfileGuests(get: BrowserSliceGet, workspaceId: string): void {
  const state = get()
  const tab = findWorkspace(state.browserTabsByWorktree, workspaceId)
  if (!tab) {
    return
  }
  const route = resolveSshWorkspaceBrowserRouteEligibility(
    getExecutionHostIdForWorktree(state, tab.worktreeId),
    state.settings,
    state.runtimeEnvironments
  )
  const partition = route?.eligible
    ? verifiedPartitionByRoute.get(
        sshWorkspaceBrowserRouteKey(
          route.targetId,
          tab.sessionProfileId ?? 'default',
          route.expectedSshTargetGeneration,
          state.settings?.browserSshWorkspaceRoutingProbeSkippedTargetIds?.includes(
            route.targetId
          ) === true
        )
      )
    : resolveBrowserPagePartition({
        sessionProfileId: tab.sessionProfileId ?? null,
        sessionPartition: tab.sessionPartition ?? null,
        localProfiles: state.browserSessionProfilesByHostId[LOCAL_EXECUTION_HOST_ID],
        mirroredProfiles: state.browserSessionProfiles,
        activeOrcaProfileId: state.activeOrcaProfileId
      })
  // The route gate owns preparing/error; a profile callback cannot grant local egress.
  if (!partition) {
    return
  }
  const pages = state.browserPagesByWorkspace[workspaceId] ?? []
  const ids = pages.length
    ? pages.filter((page) => !page.docLocation).map((page) => page.id)
    : [workspaceId]
  for (const pageId of ids) {
    const webview = webviewRegistry.get(pageId)
    if (webview && webview.getAttribute('partition') !== partition) {
      admitBrowserPageMount(pageId)
      void replacePersistentWebview(pageId)
    }
  }
}
