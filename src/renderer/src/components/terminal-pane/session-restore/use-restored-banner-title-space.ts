import { useLayoutEffect } from 'react'
import { syncSessionRestoredBannerTitleSpace } from './session-restored-banner-pane-state'
import { fitPanes } from '../viewport/mounted-pane-fit'
import type { TerminalPaneMountedController } from '../mounting/use-terminal-pane-lifecycle-stage'

export function useRestoredBannerTitleSpace({
  isVisible,
  managerRef,
  terminalManager,
  paneCount,
  paneLayoutRevision,
  paneTitles,
  renamingPaneId,
  sessionRestoredBannerPaneIds,
  shouldMeasureHiddenStartup
}: Pick<
  TerminalPaneMountedController,
  | 'isVisible'
  | 'managerRef'
  | 'terminalManager'
  | 'paneCount'
  | 'paneLayoutRevision'
  | 'paneTitles'
  | 'renamingPaneId'
  | 'sessionRestoredBannerPaneIds'
  | 'shouldMeasureHiddenStartup'
>): void {
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!terminalManager || manager !== terminalManager) {
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
    managerRef,
    terminalManager
  ])
}
