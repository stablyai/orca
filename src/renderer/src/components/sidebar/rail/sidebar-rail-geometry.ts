export const SIDEBAR_RAIL_WIDTH = 52
export const SIDEBAR_RAIL_SNAP_THRESHOLD = 140
export const SIDEBAR_RAIL_TILE_SIZE = 40
export const SIDEBAR_RAIL_HEADER_SIZE = 22
export const SIDEBAR_RAIL_HOST_HEADER_SIZE = 14
export const SIDEBAR_RAIL_MOD_HELD_CLASS = 'sidebar-rail-mod-held'
export const SIDEBAR_RAIL_SHORTCUT_LIMIT = 9

export function selectRenderedSidebarWidth(state: {
  sidebarRail: boolean
  sidebarWidth: number
}): number {
  return state.sidebarRail ? SIDEBAR_RAIL_WIDTH : state.sidebarWidth
}
