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
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { getBrowserPageRuntimeEnvironmentId } from '../describe-page/browser-page-url-display'
import type { BrowserFindShortcutScope } from '../describe-page/browser-page-types'
import { RemoteBrowserPagePane } from '../stream-remote/remote-browser-page-pane'
import { BrowserPagePane } from './browser-page-pane'

export default function BrowserPane({
  browserTab,
  isActive,
  findShortcutScope
}: {
  browserTab: BrowserWorkspaceState
  isActive: boolean
  findShortcutScope?: BrowserFindShortcutScope
}): React.JSX.Element {
  const resolvedFindShortcutScope = findShortcutScope ?? (isActive ? 'focused' : 'inactive')
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
  const browserPageIds = useMemo(() => browserPages.map((page) => page.id), [browserPages])
  const automationVisiblePageIds = useBrowserAutomationVisiblePageIds(browserPageIds)
  const mobileDrivenPageIds = useBrowserMobileDrivenPageIds(browserPageIds)
  // Why: inactive webviews must stay mounted in their original DOM parent; unmounting/reparenting loses form text and SPA state.
  const renderedBrowserPages = browserPages.filter(
    (page) => !getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)
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
    return activeBrowserPage ? (
      <RemoteBrowserPagePane
        key={`${activeBrowserRuntimeEnvironmentId ?? ''}:${activeBrowserPage.id}`}
        browserTab={activeBrowserPage}
        runtimeEnvironmentId={activeBrowserRuntimeEnvironmentId}
        worktreeId={browserTab.worktreeId}
        isActive={isActive}
        onUpdatePageState={updateBrowserPageState}
        onSetUrl={setBrowserPageUrl}
      />
    ) : (
      <div className="flex h-full min-h-0 flex-1 bg-background" />
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {renderedBrowserPages.length > 0 ? (
        <div className="relative flex min-h-0 flex-1">
          {renderedBrowserPages.map((page) => (
            <BrowserPagePane
              key={page.id}
              browserTab={page}
              workspaceId={browserTab.id}
              worktreeId={browserTab.worktreeId}
              sessionProfileId={browserTab.sessionProfileId ?? null}
              sessionPartition={browserTab.sessionPartition ?? null}
              isActive={isActive && page.id === activeBrowserPage?.id}
              findShortcutScope={
                page.id === activeBrowserPage?.id ? resolvedFindShortcutScope : 'inactive'
              }
              isAutomationVisible={automationVisiblePageIds.has(page.id)}
              isMobileDriven={mobileDrivenPageIds.has(page.id)}
              inputLocked={activeBrowserDriver.kind === 'mobile'}
              onUpdatePageState={updateBrowserPageState}
              onSetUrl={setBrowserPageUrl}
            />
          ))}
          <BrowserMobileDriverOverlay
            driver={activeBrowserDriver}
            onTakeBack={reclaimActiveBrowserForDesktop}
          />
        </div>
      ) : null}
    </div>
  )
}
