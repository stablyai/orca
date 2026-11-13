import { createContext, useContext } from 'react'

export const TAB_STRIP_ORIENTATION = { horizontal: 'horizontal', vertical: 'vertical' } as const
export type TabStripOrientation = (typeof TAB_STRIP_ORIENTATION)[keyof typeof TAB_STRIP_ORIENTATION]

const TabStripOrientationContext = createContext<TabStripOrientation>(
  TAB_STRIP_ORIENTATION.horizontal
)

export const TabStripOrientationProvider = TabStripOrientationContext.Provider

export function useTabStripOrientation(): TabStripOrientation {
  return useContext(TabStripOrientationContext)
}
