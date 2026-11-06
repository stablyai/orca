const LIVE_WIDTH_PROPERTY = '--workspace-sidebar-live-width'

type SidebarLiveWidthState = { width: string | null; targets: Set<HTMLElement> }
type SidebarLiveWidthHotData = { sidebarLiveWidth?: SidebarLiveWidthState }

// Why: Radix keeps open drawers' refs stable across HMR, so registrations must survive module re-evaluation.
function sharedState(hotData?: SidebarLiveWidthHotData): SidebarLiveWidthState {
  const state = hotData?.sidebarLiveWidth ?? { width: null, targets: new Set<HTMLElement>() }
  if (hotData) {
    hotData.sidebarLiveWidth = state
  }
  return state
}

const state = sharedState(import.meta.hot?.data)

// Why: a custom property on :root restyles the whole document every drag frame; only the drawers read it.
export function setSidebarLiveWidth(width: number): void {
  const next = `${width}px`
  if (next === state.width) {
    return
  }
  state.width = next
  for (const target of state.targets) {
    target.style.setProperty(LIVE_WIDTH_PROPERTY, next)
  }
}

// Ref callback: applies the current width on mount so a drawer opened mid-drag starts at the sidebar edge.
export function trackSidebarLiveWidth(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return undefined
  }
  if (state.width !== null) {
    element.style.setProperty(LIVE_WIDTH_PROPERTY, state.width)
  }
  state.targets.add(element)
  return () => {
    state.targets.delete(element)
  }
}
