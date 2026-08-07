import type { WorkspaceSidebarPosition } from '../../../shared/types'
import { shouldRenderDesktopWindowChrome } from './desktop-window-chrome'

/** Workspace list vs the activity/explorer panel — the two sidebars that can swap edges. */
export type SidebarSlotOccupant = 'workspace' | 'activity'
export type WindowEdge = 'left' | 'right'

export type SidebarSlotLayoutInput = {
  workspaceSidebarPosition: WorkspaceSidebarPosition
  platform: NodeJS.Platform
  isWebClient: boolean
}

export type SidebarSlotLayout = {
  leftOccupant: SidebarSlotOccupant
  rightOccupant: SidebarSlotOccupant
  /** Edge holding the OS window controls, or null where none are drawn over the sidebars. */
  windowControlsEdge: WindowEdge | null
  /** Sidebar sharing an edge with the window controls, so it must inset to keep its top row reachable. */
  windowControlsOccupant: SidebarSlotOccupant | null
}

// Why: macOS keeps native traffic lights top-left while custom desktop chrome
// draws its overlay top-right, so the occupied edge flips per platform.
function resolveWindowControlsEdge(input: SidebarSlotLayoutInput): WindowEdge | null {
  if (input.platform === 'darwin' && !input.isWebClient) {
    return 'left'
  }
  return shouldRenderDesktopWindowChrome(input) ? 'right' : null
}

export type SidebarSlotChromeInput = {
  leftOccupant: SidebarSlotOccupant
  workspaceSidebarOpen: boolean
  activitySidebarOpen: boolean
  /** Whether the left column mounts its own titlebar-height header instead of the full-width titlebar. */
  leftTitlebarChromeMounted: boolean
  stackedSidebarOpen: boolean
}

export type SidebarSlotChrome = {
  leftSlotOpen: boolean
  trailingSlotOpen: boolean
  /** The left header outlives its collapsed body, so it floats over the center column. */
  leftColumnHeaderFloating: boolean
}

// Why: collapse chrome must follow whichever sidebar holds a slot, not the workspace list, or a
// left-mounted activity sidebar can't reclaim its space and tabs run under the floating header.
export function resolveSidebarSlotChrome({
  leftOccupant,
  workspaceSidebarOpen,
  activitySidebarOpen,
  leftTitlebarChromeMounted,
  stackedSidebarOpen
}: SidebarSlotChromeInput): SidebarSlotChrome {
  const workspaceOnLeft = leftOccupant === 'workspace'
  const leftSlotOpen = workspaceOnLeft ? workspaceSidebarOpen : activitySidebarOpen
  return {
    leftSlotOpen,
    trailingSlotOpen: workspaceOnLeft ? activitySidebarOpen : workspaceSidebarOpen,
    leftColumnHeaderFloating: leftTitlebarChromeMounted && !leftSlotOpen && !stackedSidebarOpen
  }
}

export function resolveSidebarSlotLayout(input: SidebarSlotLayoutInput): SidebarSlotLayout {
  const workspaceOnLeft = input.workspaceSidebarPosition === 'left'
  const leftOccupant: SidebarSlotOccupant = workspaceOnLeft ? 'workspace' : 'activity'
  const rightOccupant: SidebarSlotOccupant = workspaceOnLeft ? 'activity' : 'workspace'
  const windowControlsEdge = resolveWindowControlsEdge(input)
  return {
    leftOccupant,
    rightOccupant,
    windowControlsEdge,
    windowControlsOccupant:
      windowControlsEdge === null
        ? null
        : windowControlsEdge === 'left'
          ? leftOccupant
          : rightOccupant
  }
}
