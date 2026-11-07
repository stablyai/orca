import { useLayoutEffect } from 'react'
import { syncSessionRestoredBannerTitleSpace } from '../session-restored-banner-pane-state'
import { fitPanes } from '../viewport/mounted-pane-fit'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useRestoredBannerTitleSpace({
  isVisible,
  managerRef,
  paneCount,
  paneLayoutRevision,
  paneTitles,
  renamingPaneId,
  sessionRestoredBannerPaneIds,
  shouldMeasureHiddenStartup
}: Pick<
  TerminalPaneCloseController,
  | 'isVisible'
  | 'managerRef'
  | 'paneCount'
  | 'paneLayoutRevision'
  | 'paneTitles'
  | 'renamingPaneId'
  | 'sessionRestoredBannerPaneIds'
  | 'shouldMeasureHiddenStartup'
>): void {
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: manager.getPanes(),
      paneTitles,
      renamingPaneId,
      sessionRestoredBannerPaneIds
    })
    if (needsFit && (isVisible || shouldMeasureHiddenStartup)) {
      fitPanes(manager)
    }
  }, [
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup,
    managerRef
  ])
}
