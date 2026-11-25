import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { isClientHostedBrowserPageHandle } from '@/store/slices/browser/hosts/browser-host-state'
import type { BrowserWorkspace as BrowserWorkspaceState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { replacePersistentWebview } from '../host-guest/browser-webview-disposal'
import { useBrowserAutomationVisiblePageIds } from '../host-guest/retention/browser-automation-visibility'
import { getBrowserPagesForWorkspace } from './browser-pane-page-selection'
import { BrowserMobileDriverOverlay } from './feedback/BrowserMobileDriverOverlay'
import {
  useBrowserDriverForPage,
  useBrowserMobileDrivenPageIds
} from '@/runtime/browser/ownership/browser-mobile-driver-state'
import { IDLE_BROWSER_DRIVER } from '@/runtime/browser/ownership/browser-mobile-driver-store'
import { useBrowserRemotelyViewedPageIds } from '@/runtime/browser/ownership/browser-remote-viewer-state'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { getBrowserPageRuntimeEnvironmentId } from '../../../../../shared/browser/browser-page-runtime-owner'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { RemoteBrowserPagePane } from '../stream-remote/remote-browser-page-pane'
import { ClientHostedBrowserPagePane } from './client-hosted/ClientHostedBrowserPagePane'
import { BrowserPagePane } from './browser-page-pane'
import { WorkspaceDocPagePane } from '../workspace-doc/workspace-doc-page-pane'
import { DeferredBrowserContent } from './DeferredBrowserContent'
import { isBrowserPagePanePaintable } from '../host-guest/retention/browser-page-paintability'
import { SshRoutedBrowserPageGate } from './profile-routing/ssh-routed-browser-page-gate'
import {
  ManagedBrowserProfileHold,
  useManagedBrowserProfileStatus
} from './profile-routing/managed-browser-profile-hold'
import { useBrowserPageMountAdmissions } from '../host-guest/retention/browser-page-mount-admission'
import { takeBackAllFromPhone } from '../../terminal-pane/viewport/take-back-all-from-phone'

export default function BrowserPane({
  browserTab,
  isActive,
  isWorktreeActive = true,
  chromeShortcutScope
}: {
  browserTab: BrowserWorkspaceState
  isActive: boolean
  isWorktreeActive?: boolean
  chromeShortcutScope?: BrowserChromeShortcutScope
}): React.JSX.Element {
  const resolvedChromeShortcutScope = chromeShortcutScope ?? (isActive ? 'focused' : 'inactive')
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, browserTab.worktreeId)
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
  const localBrowserPages = useMemo(
    () =>
      browserPages.filter(
        (page) => !getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)
      ),
    [browserPages, activeRuntimeEnvironmentId]
  )
  // Routing guards every local guest, including pages hidden after their first activation.
  const localBrowserPageIds = useMemo(
    () => localBrowserPages.map((page) => page.id),
    [localBrowserPages]
  )
  const mountAdmissions = useBrowserPageMountAdmissions(localBrowserPageIds)
  const managedProfileStatus = useManagedBrowserProfileStatus(browserTab.sessionProfileId)
  const pageDriver = useBrowserDriverForPage(activeBrowserPageId)
  // Why: a runtime-backed page is streamed, never locally driven, so its driver must read idle.
  const activeBrowserDriver = runtimeEnvironmentActive ? IDLE_BROWSER_DRIVER : pageDriver

  useEffect(() => {
    if (!runtimeEnvironmentActive) {
      return
    }
    for (const page of browserPages) {
      if (getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)) {
        void replacePersistentWebview(page.id)
      }
    }
  }, [activeRuntimeEnvironmentId, browserPages, runtimeEnvironmentActive])

  const localBrowserPageVisible =
    isActive && activeBrowserPage !== null && !runtimeEnvironmentActive
  useContextualTour('browser', localBrowserPageVisible, 'browser_visible')

  const reclaimActiveBrowserForDesktop = useCallback(async (): Promise<void> => {
    if (!activeBrowserPageId) {
      return
    }
    const { reclaimed } = await window.api.runtime.reclaimBrowserForDesktop(activeBrowserPageId)
    if (!reclaimed) {
      throw new Error('Could not reclaim browser control')
    }
  }, [activeBrowserPageId])

  const takeBackAllForDesktop = useCallback(async (): Promise<void> => {
    const { reclaimedBrowserPageIds } = await takeBackAllFromPhone(
      useAppStore.getState().settings ?? undefined,
      { includeBrowserPages: true }
    )
    if (activeBrowserPageId && !reclaimedBrowserPageIds.has(activeBrowserPageId)) {
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
    // Mount expected client-hosted pages before placement arrives to preserve chrome; restored client pages must also wait here because the host refuses server screencasts for them.
    const clientHosted = environmentHandle
      ? isClientHostedBrowserPageHandle(environmentHandle)
      : false
    return activeBrowserPage ? (
      clientHosted ? (
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

  // Why: until main has the workspace's profile, a webview would load on another partition or be refused.
  if (localBrowserPages.length > 0 && managedProfileStatus) {
    return <ManagedBrowserProfileHold status={managedProfileStatus} />
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {localBrowserPages.length > 0 ? (
        <SshRoutedBrowserPageGate
          worktreeId={browserTab.worktreeId}
          sessionProfileId={browserTab.sessionProfileId ?? null}
          pageIds={localBrowserPageIds}
        >
          {(routedPartition) => (
            <div className="relative flex min-h-0 flex-1">
              {localBrowserPages.map((page, index) => (
                <DeferredBrowserContent
                  key={page.id}
                  retainMounted={isWorktreeActive}
                  mountEligible={isBrowserPagePanePaintable({
                    isActive:
                      (isActive && page.id === activeBrowserPageId) ||
                      mountAdmissions[index] === '1',
                    isAutomationVisible: automationVisiblePageIds.has(page.id),
                    isMobileDriven: mobileDrivenPageIds.has(page.id),
                    hasRemoteViewer: remotelyViewedPageIds.has(page.id)
                  })}
                >
                  {page.docLocation ? (
                    <WorkspaceDocPagePane
                      page={page}
                      isActive={isActive && page.id === activeBrowserPage?.id}
                    />
                  ) : (
                    <BrowserPagePane
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
                      isMountAdmitted={mountAdmissions[index] === '1'}
                      inputLocked={activeBrowserDriver.kind === 'mobile'}
                      onUpdatePageState={updateBrowserPageState}
                      onSetUrl={setBrowserPageUrl}
                    />
                  )}
                </DeferredBrowserContent>
              ))}
              <BrowserMobileDriverOverlay
                driver={activeBrowserDriver}
                onTakeBack={reclaimActiveBrowserForDesktop}
                onTakeBackAll={takeBackAllForDesktop}
              />
            </div>
          )}
        </SshRoutedBrowserPageGate>
      ) : null}
    </div>
  )
}
