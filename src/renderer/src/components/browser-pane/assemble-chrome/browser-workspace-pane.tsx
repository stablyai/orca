import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { BrowserWorkspace as BrowserWorkspaceState } from '../../../../../shared/browser-workspace-types'
import { destroyPersistentWebview } from '../host-guest/webview-registry'
import { useBrowserAutomationVisiblePageIds } from '../host-guest/browser-automation-visibility'
import { getBrowserPagesForWorkspace } from './browser-pane-page-selection'
import { BrowserMobileDriverOverlay } from './BrowserMobileDriverOverlay'
import {
  IDLE_BROWSER_DRIVER,
  useBrowserDriverForPage,
  useBrowserMobileDrivenPageIds
} from '@/lib/pane-manager/browser-mobile-driver-state'
import { useBrowserRemotelyViewedPageIds } from '@/lib/pane-manager/browser-remote-viewer-state'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { getBrowserPageRuntimeEnvironmentId } from '../describe-page/browser-page-url-display'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { RemoteBrowserPagePane } from '../stream-remote/remote-browser-page-pane'
import { ClientHostedBrowserPagePane } from '../ClientHostedBrowserPagePane'
import { BrowserPagePane } from './browser-page-pane'
import { WorkspaceDocPagePane } from '../workspace-doc/workspace-doc-page-pane'
import { SshRoutedBrowserPageGate } from './ssh-routed-browser-page-gate'

export default function BrowserPane({
  browserTab,
  isActive,
  chromeShortcutScope
}: {
  browserTab: BrowserWorkspaceState
  isActive: boolean
  chromeShortcutScope?: BrowserChromeShortcutScope
}): React.JSX.Element {
  const resolvedChromeShortcutScope = chromeShortcutScope ?? (isActive ? 'focused' : 'inactive')
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, browserTab.worktreeId)
  )
  const browserPages = useAppStore((s) =>
    getBrowserPagesForWorkspace(s.browserPagesByWorkspace, browserTab.id)
  )
  const activeBrowserPage =
    browserPages.find((page) => page.id === browserTab.activePageId) ?? browserPages[0] ?? null
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  const activeBrowserRuntimeEnvironmentId = activeBrowserPage
    ? getBrowserPageRuntimeEnvironmentId(activeBrowserPage, activeRuntimeEnvironmentId)
    : null
  const runtimeEnvironmentActive = Boolean(activeBrowserRuntimeEnvironmentId)
  const activeBrowserPageId = activeBrowserPage?.id ?? null
  const activeRemotePageHandle = useAppStore((state) =>
    activeBrowserPageId
      ? (state.remoteBrowserPageHandlesByPageId[activeBrowserPageId] ?? null)
      : null
  )
  const browserPageIds = useMemo(() => browserPages.map((page) => page.id), [browserPages])
  const automationVisiblePageIds = useBrowserAutomationVisiblePageIds(browserPageIds)
  const mobileDrivenPageIds = useBrowserMobileDrivenPageIds(browserPageIds)
  const remotelyViewedPageIds = useBrowserRemotelyViewedPageIds(browserPageIds)
  // Why: inactive webviews must stay mounted in their original DOM parent; unmounting/reparenting loses form text and SPA state.
  const renderedBrowserPages = useMemo(
    () =>
      browserPages.filter(
        (page) => !getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)
      ),
    [browserPages, activeRuntimeEnvironmentId]
  )
  const renderedBrowserPageIds = useMemo(
    () => renderedBrowserPages.map((page) => page.id),
    [renderedBrowserPages]
  )
  const pageDriver = useBrowserDriverForPage(activeBrowserPageId)
  // Why: a runtime-backed page is streamed, never locally driven, so its driver must read idle.
  const activeBrowserDriver = runtimeEnvironmentActive ? IDLE_BROWSER_DRIVER : pageDriver

  useEffect(() => {
    if (!runtimeEnvironmentActive) {
      return
    }
    for (const page of browserPages) {
      if (getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)) {
        destroyPersistentWebview(page.id)
      }
    }
  }, [activeRuntimeEnvironmentId, browserPages, runtimeEnvironmentActive])

  useContextualTour(
    'browser',
    isActive && activeBrowserPage !== null && !runtimeEnvironmentActive,
    'browser_visible'
  )

  const reclaimActiveBrowserForDesktop = useCallback(async (): Promise<void> => {
    if (!activeBrowserPageId) {
      return
    }
    const { reclaimed } = await window.api.runtime.reclaimBrowserForDesktop(activeBrowserPageId)
    if (!reclaimed) {
      throw new Error('Could not reclaim browser control')
    }
  }, [activeBrowserPageId])

  if (activeBrowserRuntimeEnvironmentId) {
    const environmentHandle =
      activeRemotePageHandle?.environmentId === activeBrowserRuntimeEnvironmentId
        ? activeRemotePageHandle
        : null
    const clientPlacement =
      environmentHandle?.placement?.kind === 'client' ? environmentHandle.placement : null
    // Why: a staged page this client expects to host itself mounts the client-hosted pane from the
    // first frame. The host mints the placement, so keying on it would swap component and key at
    // adoption — a remount that replays open dropdowns and throws away focus and drafts. The pane
    // renders connecting until adoption fills the placement in.
    const stagedClientHosted =
      environmentHandle?.staged === true && environmentHandle.stagedClientHosted === true
    // Why: a row restored from a previous run has no placement until the relaunched host recovers
    // the page, and the streamed pane would meanwhile open a server screencast the host refuses
    // for a client-placed page. It mounts quiet on the client pane until adoption fills it in.
    const restoredClientHosted = environmentHandle?.restoredClientHosted === true
    return activeBrowserPage ? (
      clientPlacement || stagedClientHosted || restoredClientHosted ? (
        <ClientHostedBrowserPagePane
          key={`${activeBrowserRuntimeEnvironmentId}:${activeBrowserPage.id}`}
          browserTab={activeBrowserPage}
          workspaceId={browserTab.id}
          runtimeEnvironmentId={activeBrowserRuntimeEnvironmentId}
          worktreeId={browserTab.worktreeId}
          placement={clientPlacement}
          isActive={isActive}
          chromeShortcutScope={resolvedChromeShortcutScope}
          onUpdatePageState={updateBrowserPageState}
          onSetUrl={setBrowserPageUrl}
        />
      ) : (
        <RemoteBrowserPagePane
          key={`${activeBrowserRuntimeEnvironmentId}:${activeBrowserPage.id}`}
          browserTab={activeBrowserPage}
          workspaceId={browserTab.id}
          runtimeEnvironmentId={activeBrowserRuntimeEnvironmentId}
          worktreeId={browserTab.worktreeId}
          isActive={isActive}
          chromeShortcutScope={resolvedChromeShortcutScope}
          onUpdatePageState={updateBrowserPageState}
          onSetUrl={setBrowserPageUrl}
        />
      )
    ) : (
      <div className="flex h-full min-h-0 flex-1 bg-background" />
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {renderedBrowserPages.length > 0 ? (
        <SshRoutedBrowserPageGate
          worktreeId={browserTab.worktreeId}
          sessionProfileId={browserTab.sessionProfileId ?? null}
          pageIds={renderedBrowserPageIds}
        >
          {(routedPartition) => (
            <div className="relative flex min-h-0 flex-1">
              {renderedBrowserPages.map((page) =>
                page.docLocation ? (
                  <WorkspaceDocPagePane
                    key={page.id}
                    page={page}
                    isActive={isActive && page.id === activeBrowserPage?.id}
                  />
                ) : (
                  <BrowserPagePane
                    key={page.id}
                    browserTab={page}
                    workspaceId={browserTab.id}
                    worktreeId={browserTab.worktreeId}
                    sessionProfileId={browserTab.sessionProfileId ?? null}
                    sessionPartition={routedPartition ?? browserTab.sessionPartition ?? null}
                    isActive={isActive && page.id === activeBrowserPage?.id}
                    chromeShortcutScope={
                      page.id === activeBrowserPage?.id ? resolvedChromeShortcutScope : 'inactive'
                    }
                    isAutomationVisible={automationVisiblePageIds.has(page.id)}
                    isMobileDriven={mobileDrivenPageIds.has(page.id)}
                    isRemotelyViewed={remotelyViewedPageIds.has(page.id)}
                    inputLocked={activeBrowserDriver.kind === 'mobile'}
                    onUpdatePageState={updateBrowserPageState}
                    onSetUrl={setBrowserPageUrl}
                  />
                )
              )}
              <BrowserMobileDriverOverlay
                driver={activeBrowserDriver}
                onTakeBack={reclaimActiveBrowserForDesktop}
              />
            </div>
          )}
        </SshRoutedBrowserPageGate>
      ) : null}
    </div>
  )
}
