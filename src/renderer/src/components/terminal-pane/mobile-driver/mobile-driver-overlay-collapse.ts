export type MobileDriverOverlayCollapseState = {
  driverClientId: string | null
  collapsed: boolean
}

export function getMobileDriverOverlayCollapseState(
  state: MobileDriverOverlayCollapseState,
  driverClientId: string | null
): MobileDriverOverlayCollapseState {
  return state.driverClientId === driverClientId
    ? state
    : {
        driverClientId,
        collapsed: false
      }
}

export function createMobileDriverOverlayCollapseState(
  driverClientId: string | null
): MobileDriverOverlayCollapseState {
  return {
    driverClientId,
    collapsed: false
  }
}
