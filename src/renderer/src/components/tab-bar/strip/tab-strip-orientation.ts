import { createContext, useContext } from 'react'

/** Horizontal: the strip above a split. Vertical: the left tab list (Tab position: Left). */
export type TabStripOrientation = 'horizontal' | 'vertical'

export const TabStripOrientationContext = createContext<TabStripOrientation>('horizontal')

/** Why a context: every tab kind reads it, and the rows between the list and the tabs stay unchanged. */
export function useTabStripOrientation(): TabStripOrientation {
  return useContext(TabStripOrientationContext)
}

const ACTIVE_VERTICAL_TAB_ATTRIBUTES = { role: 'tab', tabIndex: 0 } as const
const INACTIVE_VERTICAL_TAB_ATTRIBUTES = { role: 'tab', tabIndex: -1 } as const

/**
 * dnd-kit drag attributes: rows in the vertical tablist announce as tabs with a roving tab stop
 * (Tab enters at the active row, arrows move between rows); strip tabs keep dnd-kit's defaults.
 */
export function useTabStripDragAttributes(
  isActive: boolean
): { role: 'tab'; tabIndex: 0 | -1 } | undefined {
  if (useTabStripOrientation() !== 'vertical') {
    return undefined
  }
  return isActive ? ACTIVE_VERTICAL_TAB_ATTRIBUTES : INACTIVE_VERTICAL_TAB_ATTRIBUTES
}
