import { createContext, useContext } from 'react'

/** The discrete part of a strip's condense plan; the active width lives in a CSS variable. */
export type TabStripDensity = {
  condensed: boolean
  iconIds: ReadonlySet<string>
  /** Widths kept after a pointer close while the pointer stays in the strip. */
  heldWidths: ReadonlyMap<string, number> | null
}

const NO_IDS: ReadonlySet<string> = new Set()

export const TITLED_TAB_STRIP_DENSITY: TabStripDensity = {
  condensed: false,
  iconIds: NO_IDS,
  heldWidths: null
}

export const TabStripDensityContext = createContext<TabStripDensity>(TITLED_TAB_STRIP_DENSITY)

export function useTabStripIconOnly(tabId: string): boolean {
  return useContext(TabStripDensityContext).iconIds.has(tabId)
}
