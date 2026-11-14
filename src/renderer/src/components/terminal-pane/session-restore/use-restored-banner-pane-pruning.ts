import { useEffect } from 'react'
import { pruneSessionRestoredBannerPaneIds } from './session-restored-banner-pane-state'
import type { TerminalPaneMountedController } from '../mounting/use-terminal-pane-lifecycle-stage'

export function useRestoredBannerPanePruning({
  managerRef,
  terminalManager,
  paneCount,
  setSessionRestoredBannerPaneIds
}: Pick<
  TerminalPaneMountedController,
  'managerRef' | 'terminalManager' | 'paneCount' | 'setSessionRestoredBannerPaneIds'
>): void {
  useEffect(() => {
    const manager = managerRef.current
    if (!terminalManager || manager !== terminalManager) {
      return
    }
    setSessionRestoredBannerPaneIds((previous) => {
      const next = pruneSessionRestoredBannerPaneIds(previous, manager.getPanes())
      return next === previous ? previous : next
    })
  }, [terminalManager, paneCount, managerRef, setSessionRestoredBannerPaneIds])
}
