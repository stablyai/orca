import { createContext, useContext } from 'react'

// React ownership follows menus and submenus through body portals.
export const SidebarZoomContext = createContext(false)

export function useSidebarZoomAttribute(): '' | undefined {
  return useContext(SidebarZoomContext) ? '' : undefined
}
