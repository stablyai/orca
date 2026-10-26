import { useEffect } from 'react'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'
import type { TerminalPaneLayoutController } from './use-terminal-pane-layout-persistence'

/** Sync owner-published pane titles while retaining pending local renames until host echo. */
export function hostPaneTitleUpdates(args: {
  layout: TerminalLayoutSnapshot
  panes: readonly { id: number; leafId: string }[]
  shownTitles: Readonly<Record<number, string>>
}): Map<number, string | null> {
  const updates = new Map<number, string | null>()
  const ptyIds = Object.values(args.layout.ptyIdsByLeafId ?? {})
  // Switch point: main publishes every layout; otherwise local tabs are the window's own.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN && !ptyIds.some((ptyId) => isRemoteRuntimePtyId(ptyId))) {
    return updates
  }
  const hostLeafIds = new Set(collectLeafIdsInOrder(args.layout.root))
  for (const pane of args.panes) {
    if (!hostLeafIds.has(pane.leafId)) {
      continue
    }
    const hostTitle = args.layout.titlesByLeafId?.[pane.leafId]?.trim() || null
    if ((args.shownTitles[pane.id] ?? null) !== hostTitle) {
      updates.set(pane.id, hostTitle)
    }
  }
  return updates
}

/** Open panes follow pane names the host publishes, not only the ones they opened with. */
export function useHostPaneTitleSync(controller: TerminalPaneLayoutController): void {
  const { managerRef, paneLayoutRevision, paneTitlesRef, savedLayout, setPaneTitles } = controller
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const updates = hostPaneTitleUpdates({
      layout: savedLayout,
      panes: manager.getPanes(),
      shownTitles: paneTitlesRef.current
    })
    if (updates.size === 0) {
      return
    }
    const apply = (previous: Record<number, string>): Record<number, string> => {
      const next = { ...previous }
      for (const [paneId, title] of updates) {
        if (title === null) {
          delete next[paneId]
        } else {
          next[paneId] = title
        }
      }
      return next
    }
    // The store already holds the owner's layout, so nothing is persisted or pushed back.
    paneTitlesRef.current = apply(paneTitlesRef.current)
    setPaneTitles(apply)
  }, [managerRef, paneLayoutRevision, paneTitlesRef, savedLayout, setPaneTitles])
}
