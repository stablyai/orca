import { useLayoutEffect } from 'react'
import { bindPanePtyId } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import type { TerminalPaneCloseController } from '../close/use-terminal-pane-close-actions'

export function useSavedPanePtyBindings({
  managerRef,
  paneTransportsRef,
  savedLayout,
  tabId
}: Pick<
  TerminalPaneCloseController,
  'managerRef' | 'paneTransportsRef' | 'savedLayout' | 'tabId'
>) {
  const panePtyLayoutBindings = savedLayout.ptyIdsByLeafId
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }

    // Unbound remounts may catch up to replacement ownership; a live mismatched transport must never overwrite it.
    for (const pane of manager.getPanes()) {
      const expectedPtyId = panePtyLayoutBindings?.[pane.leafId]
      if (!expectedPtyId) {
        continue
      }
      const transport = paneTransportsRef.current.get(pane.id)
      if (transport && transport.getPtyId() && transport.getPtyId() !== expectedPtyId) {
        continue
      }
      if (pane.container.dataset.ptyId === expectedPtyId) {
        continue
      }
      bindPanePtyId(pane.id, expectedPtyId, tabId)
      pane.container.dataset.ptyId = expectedPtyId
    }
  }, [managerRef, panePtyLayoutBindings, paneTransportsRef, tabId])
  return { panePtyLayoutBindings }
}
