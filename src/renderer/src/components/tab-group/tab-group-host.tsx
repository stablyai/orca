import { createContext, useContext } from 'react'
import { useAppStore } from '../../store'
import type { TabBarProps } from '../tab-bar/tab-bar-props'

/** The tab-strip entries a host can own because only it knows where new things belong. */
export type TabGroupNewTabActions = Pick<
  TabBarProps,
  | 'onNewTerminalTab'
  | 'onNewTerminalWithShell'
  | 'onNewBrowserTab'
  | 'onNewSimulatorTab'
  | 'onOpenEntry'
  | 'onNewFileTab'
  | 'onOpenFileTab'
  | 'newTabMenuOrder'
>

/**
 * What a surface that mounts tab groups tells them about itself. Groups own layout, panes, selection
 * and closing; the host owns only the chrome around its tab strips and where its new tabs go.
 */
export type TabGroupHost = {
  /** Rendered at the start of the top-left group's strip, e.g. space under overlaid window chrome. */
  headerStart?: React.ReactNode
  /** Rendered at the end of the top-right group's strip. */
  headerEnd?: React.ReactNode
  tabStripChrome?: TabBarProps['tabStripChrome']
  markdownAnnotationsEnabled?: boolean
  /** Shown in a group's body while it has no tab to render. */
  emptyGroupBody?: React.ReactNode
  /** Replaces the group's own new-tab entries; omitted entries fall back to the group's. */
  newTabActions?: (groupId: string) => Partial<TabGroupNewTabActions>
}

// Why a spread: React's CSSProperties has no WebkitAppRegion, and a spread skips the excess-property
// check that would otherwise need a cast.
const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as const

// Why components rather than values: each subscribes to its own sidebar flag, so a toggle
// re-renders one spacer instead of every group.
// Why no-drag: Electron's drag hit-test honours no-drag only on DOM descendants, not z-index
// siblings, so these keep the overlaid sidebar toggles and window controls clickable.
function CollapsedSidebarHeaderReservation(): React.JSX.Element | null {
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  return sidebarOpen ? null : (
    <div
      className="shrink-0"
      style={{ width: 'var(--collapsed-sidebar-header-width)', ...NO_DRAG_REGION }}
    />
  )
}

function ClosedExplorerHeaderReservation(): React.JSX.Element | null {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  return rightSidebarOpen ? null : (
    <div
      className="shrink-0"
      style={{ width: 'calc(40px + var(--window-controls-width, 0px))', ...NO_DRAG_REGION }}
    />
  )
}

const MAIN_WORKSPACE_HOST: TabGroupHost = {
  headerStart: <CollapsedSidebarHeaderReservation />,
  headerEnd: <ClosedExplorerHeaderReservation />
}

const TabGroupHostContext = createContext<TabGroupHost>(MAIN_WORKSPACE_HOST)

export const TabGroupHostProvider = TabGroupHostContext.Provider

export function useTabGroupHost(): TabGroupHost {
  return useContext(TabGroupHostContext)
}
