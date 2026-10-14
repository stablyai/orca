import { useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { isAutoHideSingleTabStripEnabled } from './auto-hide-single-tab-strip-preference'
import { resolveSingleTabStripVisibility } from './single-tab-strip-visibility'
import { queueSyncFitPanes } from './sync-fit-panes-request'
import { useTabStripRenameHold } from './tab-strip-rename-hold'
import { useTabStripRevealHover } from './tab-strip-reveal-hover'

/** One group's strip auto-hide state: collapsed while the group holds a single tab, revealed on hover. */
export function useSingleTabStripAutoHide({
  stripAttached,
  groupTabCount,
  clientHostedRowCount,
  tabDragActive,
  isVisible,
  ownsTab
}: {
  /** False for an 'external' host: it renders the strip itself, so there is nothing here to collapse. */
  stripAttached: boolean
  groupTabCount: number
  clientHostedRowCount: number
  tabDragActive: boolean
  isVisible: boolean
  /** Whether a rename request's tab id belongs to this group's strip. */
  ownsTab: (tabId: string) => boolean
}): {
  stripAutoHidden: boolean
  stripRevealed: boolean
  panelRef: React.RefObject<HTMLDivElement | null>
} {
  const autoHideSingleTabStrip = useAppStore((state) =>
    isAutoHideSingleTabStripEnabled(state.settings)
  )
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [stripHovered, setStripHovered] = useState(false)
  const tabRenameActive = useTabStripRenameHold({
    enabled: autoHideSingleTabStrip && stripAttached,
    panelRef,
    ownsTab
  })
  const { autoHidden: stripAutoHidden, revealed: stripRevealed } = resolveSingleTabStripVisibility({
    autoHideEnabled: autoHideSingleTabStrip && stripAttached,
    groupTabCount,
    clientHostedRowCount,
    stripHovered,
    tabDragActive,
    tabRenameActive
  })
  // Why: the watcher stops with the collapsed strip, so a reveal that ends by gaining a tab never
  // sees the pointer leave and would come back already revealed once the group drops to one tab again.
  if (!stripAutoHidden && stripHovered) {
    setStripHovered(false)
  }
  useTabStripRevealHover({
    enabled: stripAutoHidden && isVisible,
    panelRef,
    onHoverChange: setStripHovered
  })
  // Why: this transition moves the pane body by 32px and xterm only reflows on this event; skipping
  // the mount run matters because every worktree's groups stay mounted and each would refit them all.
  const didSyncStripHeightRef = useRef(false)
  useLayoutEffect(() => {
    if (!didSyncStripHeightRef.current) {
      didSyncStripHeightRef.current = true
      return
    }
    queueSyncFitPanes()
  }, [stripAutoHidden])
  return { stripAutoHidden, stripRevealed, panelRef }
}
