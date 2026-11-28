import { useTerminalPaneAttention } from '../titles/use-terminal-pane-attention'
import { useRestoredBannerTitleSpace } from '../session-restore/use-restored-banner-title-space'
import { usePaneTitleOverlayGeometry } from '../titles/use-pane-title-overlay-geometry'
import { useRestoredBannerPanePruning } from '../session-restore/use-restored-banner-pane-pruning'
import { useTerminalShutdownBufferCapture } from '../snapshots/use-terminal-shutdown-buffer-capture'
import { usePaneTitleRenameBlurIntent } from '../titles/use-pane-title-rename-blur-intent'
import type { TerminalPaneMountedController } from '../mounting/use-terminal-pane-lifecycle-stage'

export function useTerminalPaneTitleEffects(controller: TerminalPaneMountedController): void {
  const {
    clearedScrollbackLeafIdsRef,
    containerRef,
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    managerRef,
    terminalManager,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    paneTransportsRef,
    renamingPaneId,
    renameInputRef,
    renameUserRequestedBlurCommitRef,
    sessionRestoredBannerPaneIds,
    setPaneTitleOverlayRects,
    setSessionRestoredBannerPaneIds,
    setTabLayout,
    setTabLocalOnlyScrollback,
    shouldMeasureHiddenStartup,
    tabId,
    worktreeId
  } = controller

  useTerminalPaneAttention({ terminalManager, managerRef, paneCount, tabId })

  useRestoredBannerTitleSpace({
    terminalManager,
    isVisible,
    managerRef,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    shouldMeasureHiddenStartup
  })

  usePaneTitleOverlayGeometry({
    terminalManager,
    containerRef,
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    managerRef,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    setPaneTitleOverlayRects,
    shouldMeasureHiddenStartup
  })

  useRestoredBannerPanePruning({
    terminalManager,
    managerRef,
    paneCount,
    setSessionRestoredBannerPaneIds
  })

  useTerminalShutdownBufferCapture({
    clearedScrollbackLeafIdsRef,
    managerRef,
    paneTransportsRef,
    setTabLayout,
    setTabLocalOnlyScrollback,
    tabId,
    worktreeId
  })

  usePaneTitleRenameBlurIntent({ renamingPaneId, renameInputRef, renameUserRequestedBlurCommitRef })
}
