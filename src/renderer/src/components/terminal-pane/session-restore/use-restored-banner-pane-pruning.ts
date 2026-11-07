import { useEffect } from 'react'
import { pruneSessionRestoredBannerPaneIds } from '../session-restored-banner-pane-state'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useRestoredBannerPanePruning({
  managerRef,
  paneCount,
  setSessionRestoredBannerPaneIds
}: Pick<
  TerminalPaneCloseController,
  'managerRef' | 'paneCount' | 'setSessionRestoredBannerPaneIds'
>): void {
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    setSessionRestoredBannerPaneIds((previous) => {
      const next = pruneSessionRestoredBannerPaneIds(previous, manager.getPanes())
      return next === previous ? previous : next
    })
  }, [paneCount, managerRef, setSessionRestoredBannerPaneIds])
}
