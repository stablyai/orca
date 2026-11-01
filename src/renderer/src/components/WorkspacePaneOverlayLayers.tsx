import type { ActivityTerminalPortalTarget } from './activity/activity-terminal-portal'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import { RetainedBrowserPaneOverlayLayer } from './browser-pane/assemble-chrome/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from './emulator-pane/EmulatorPaneOverlayLayer'
import StructuredAgentSessionPaneOverlayLayer from './native-chat/StructuredAgentSessionPaneOverlayLayer'
import AiVaultSessionDropLayer from './tab-group/AiVaultSessionDropLayer'
import type { HiddenTerminalPrewarm } from './terminal-pane/terminal-pane-types'

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
  /** Floating overlays leave the toggle chord to the active workspace; duplicate listeners would both toggle. */
  ownsNativeChatToggleShortcut?: boolean
}): React.JSX.Element {
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
      <RetainedBrowserPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible}
        mountEligible={mountRetainedBrowserOverlay}
      />
      {mountEmulatorOverlay ? (
        <EmulatorPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
      ) : null}
      <StructuredAgentSessionPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible}
      />
      <AiVaultSessionDropLayer worktreeId={worktreeId} enabled={isVisible} />
    </>
  )
}
