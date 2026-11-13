import { showClientCreationActionError } from '@/lib/workspace/creation/surface-policy/client-creation-action-error'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/browser/creation/web-runtime-browser-creation'
import { useAppStore } from '@/store/index'
import { isClientHostedBrowserPageHandle } from '@/store/slices/browser/hosts/browser-host-state'
import { findPage, findWorkspace } from '@/store/slices/browser/pages/browser-page-records'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import { resolveBrowserSourceUnifiedTab } from '../workspace/browser-workspace-source-resolution'
import { openUrlInTabBesideBrowserPage } from './browser-page-tab-opening'

export function isClientHostedBrowserSourcePage(browserPageId: string): boolean {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId?.[browserPageId]
  return handle ? isClientHostedBrowserPageHandle(handle) : false
}

export function openClientHostedUrlBesideBrowserPage(args: {
  sourcePageId: string
  worktreeId: string
  url: string
  activate: boolean
}): void {
  const store = useAppStore.getState()
  const sourcePage = findPage(store.browserPagesByWorkspace, args.sourcePageId)
  const handle = store.remoteBrowserPageHandlesByPageId?.[args.sourcePageId]
  const environmentId =
    handle?.environmentId?.trim() ||
    runtimeEnvironmentIdOrLocalUnlessTwin(store, args.worktreeId) ||
    sourcePage?.browserRuntimeEnvironmentId?.trim() ||
    null
  // A client-hosted row with no named runtime cannot ask the paired host, so keep the local opener.
  if (!environmentId) {
    openUrlInTabBesideBrowserPage(args)
    return
  }
  const sourceTab = sourcePage
    ? findWorkspace(store.browserTabsByWorktree, sourcePage.workspaceId)
    : null
  const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(store, args.sourcePageId, args.worktreeId)
  // Why not createBrowserTab: that lands in the streamed pane, which a headless runtime cannot show.
  // Omit placementPreference so preparation uses the same auto choice as the new-tab button.
  void createWebRuntimeSessionBrowserTab({
    worktreeId: args.worktreeId,
    environmentId,
    url: args.url,
    ...(sourceTab?.sessionProfileId ? { profileId: sourceTab.sessionProfileId } : {}),
    ...(sourceUnifiedTab ? { clientAfterTabId: sourceUnifiedTab.id } : {}),
    focusOnCreate: args.activate,
    selectWorktree: false,
    stagedTitle: redactKagiSessionToken(args.url),
    stagedFocusAddressBar: false,
    failureLogMode: 'operation-only'
  }).catch(showClientCreationActionError)
}

/** Local pages keep createBrowserTab. Client-hosted pages on a paired server follow the new-tab route. */
export function openLinkInNewBrowserTab(args: {
  sourcePageId: string
  worktreeId: string
  url: string
  activate: boolean
}): void {
  if (isClientHostedBrowserSourcePage(args.sourcePageId)) {
    openClientHostedUrlBesideBrowserPage(args)
    return
  }
  openUrlInTabBesideBrowserPage(args)
}
