import { useMediaQuery } from '@/hooks/use-media-query'
import { useAppStore } from '@/store'
import { TAB_STRIP_PLACEMENT } from '../../../../shared/tab-types'

const TAB_SIDE_PANEL_UNSUPPORTED_QUERY = '(pointer: coarse), (max-width: 767px)'

/** Why the query: phones lack the width, and the panel's resize handle only responds to a mouse. */
export function useTabSidePanelEnabled(hasAttachedStrip: boolean): boolean {
  const placement = useAppStore((state) => state.settings?.tabStripPlacement)
  const unsupported = useMediaQuery(TAB_SIDE_PANEL_UNSUPPORTED_QUERY)
  return hasAttachedStrip && placement === TAB_STRIP_PLACEMENT.rightPanel && !unsupported
}
