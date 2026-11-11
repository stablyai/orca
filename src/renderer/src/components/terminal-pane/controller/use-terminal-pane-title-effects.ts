import { useTerminalPaneAttention } from '../titles/use-terminal-pane-attention'
import { useRestoredBannerTitleSpace } from '../session-restore/use-restored-banner-title-space'
import { usePaneTitleOverlayGeometry } from '../titles/use-pane-title-overlay-geometry'
import { useRestoredBannerPanePruning } from '../session-restore/use-restored-banner-pane-pruning'
import { useTerminalShutdownBufferCapture } from '../snapshots/use-terminal-shutdown-buffer-capture'
import { usePaneTitleRenameBlurIntent } from '../titles/use-pane-title-rename-blur-intent'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useTerminalPaneTitleEffects(controller: TerminalPaneCloseController): void {
  const {
    clearedScrollbackLeafIdsRef,
    containerRef,
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    managerRef,
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

  useTerminalPaneAttention({ managerRef, paneCount, tabId })

  useRestoredBannerTitleSpace({
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

  useRestoredBannerPanePruning({ managerRef, paneCount, setSessionRestoredBannerPaneIds })

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
