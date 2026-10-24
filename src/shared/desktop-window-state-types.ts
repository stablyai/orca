import type { PersistedUIState } from './persisted-ui-state-types'
import type { DesktopLayoutView } from './workspace-layout/workspace-layout-beside'

export const DESKTOP_WINDOW_UI_FIELDS = [
  'lastActiveRepoId',
  'lastActiveWorktreeId',
  'activeView',
  'sidebarWidth',
  'sidebarOpen',
  'rightSidebarOpen',
  'rightSidebarTab',
  'rightSidebarWidth',
  'uiZoomLevel'
] as const satisfies readonly (keyof PersistedUIState)[]

export type DesktopWindowUI = Pick<PersistedUIState, (typeof DESKTOP_WINDOW_UI_FIELDS)[number]>

export type PersistedDesktopWindowState = {
  open: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
  ui?: Partial<DesktopWindowUI>
  viewsByHostId?: Record<string, DesktopLayoutView>
}
