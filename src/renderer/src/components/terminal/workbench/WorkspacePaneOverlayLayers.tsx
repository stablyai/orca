import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import { useClientHostedBrowserRows } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { isStructuredTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { ActivityTerminalPortalTarget } from '../../activity/terminal-portal/activity-terminal-portal'
import TerminalPaneOverlayLayer from '../../terminal-pane/mounting/TerminalPaneOverlayLayer'
import AiVaultSessionDropLayer from '../../tab-group/drag/AiVaultSessionDropLayer'
import type { HiddenTerminalPrewarm } from '../../terminal-pane/controller/terminal-pane-types'

const LazyRetainedBrowserPaneOverlayLayer = lazy(() =>
  import('../../browser-pane/assemble-chrome/BrowserPaneOverlayLayer').then((module) => ({
    default: module.RetainedBrowserPaneOverlayLayer
  }))
)
const LazyEmulatorPaneOverlayLayer = lazy(
  () => import('../../emulator-pane/EmulatorPaneOverlayLayer')
)
const LazyStructuredAgentSessionPaneOverlayLayer = lazy(
  () => import('../../native-chat/pane/routing/StructuredAgentSessionPaneOverlayLayer')
)

/** Share retained pane hosts across group-tree hosts so retention, parking and browser paint have one lifecycle owner. */
export function WorkspacePaneOverlayLayers({
  worktreeId,
  worktreePath,
  isVisible,
  shouldMeasureHiddenWorktree,
  hiddenTerminalPrewarm = null,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds,
  mountRetainedBrowserOverlay,
  mountEmulatorOverlay,
  surfaceReleased = false,
  ownsNativeChatToggleShortcut = true
}: {
  worktreeId: string
  worktreePath: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hiddenTerminalPrewarm?: HiddenTerminalPrewarm | null
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
  mountRetainedBrowserOverlay: boolean
  mountEmulatorOverlay: boolean
  /** Parked hidden workspace: its drop target remounts on return. */
  surfaceReleased?: boolean
  /** Floating overlays leave the toggle chord to the active workspace; duplicate listeners would both toggle. */
  ownsNativeChatToggleShortcut?: boolean
}): React.JSX.Element {
  const hasBrowserTabs = useAppStore(
    (state) => (state.browserTabsByWorktree[worktreeId]?.length ?? 0) > 0
  )
  const hasClientHostedBrowserRows = useClientHostedBrowserRows(worktreeId).length > 0
  const hasEmulatorTabs = useAppStore(
    (state) =>
      state.unifiedTabsByWorktree[worktreeId]?.some((tab) => tab.contentType === 'simulator') ??
      false
  )
  const hasStructuredOrRoomTabs = useAppStore(
    (state) =>
      state.unifiedTabsByWorktree[worktreeId]?.some(
        (tab) => isStructuredTab(tab) || tab.contentType === 'room'
      ) ?? false
  )

  return (
    <>
      <TerminalPaneOverlayLayer
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isWorktreeActive={isVisible}
        coldParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        hiddenTerminalPrewarm={hiddenTerminalPrewarm}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
        ownsNativeChatToggleShortcut={ownsNativeChatToggleShortcut}
      />
      {hasBrowserTabs || hasClientHostedBrowserRows ? (
        <Suspense fallback={null}>
          <LazyRetainedBrowserPaneOverlayLayer
            worktreeId={worktreeId}
            isWorktreeActive={isVisible}
            mountEligible={mountRetainedBrowserOverlay}
          />
        </Suspense>
      ) : null}
      {mountEmulatorOverlay && hasEmulatorTabs ? (
        <Suspense fallback={null}>
          <LazyEmulatorPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
        </Suspense>
      ) : null}
      {/* Chat retention bounds itself; its reader position lives only in the mounted view. */}
      {hasStructuredOrRoomTabs ? (
        <Suspense fallback={null}>
          <LazyStructuredAgentSessionPaneOverlayLayer
            worktreeId={worktreeId}
            isWorktreeActive={isVisible}
          />
        </Suspense>
      ) : null}
      {surfaceReleased ? null : (
        <AiVaultSessionDropLayer worktreeId={worktreeId} enabled={isVisible} />
      )}
    </>
  )
}
