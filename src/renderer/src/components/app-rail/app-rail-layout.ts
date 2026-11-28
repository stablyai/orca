import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { UISlice } from '@/store/slices/ui/ui-slice-contract'

/** Matches the right sidebar's side activity bar. */
export const APP_RAIL_WIDTH = 40

/** The workspace list column; rail items that fill it point here with aria-controls. */
export const WORKSPACE_LIST_REGION_ID = 'workspace-list-region'

type AppRailSettingsState = { settings: Pick<GlobalSettings, 'experimentalAppRail'> | null }

export function selectAppRailVisible(state: AppRailSettingsState): boolean {
  return state.settings?.experimentalAppRail === true
}

export function selectAppRailWidth(state: AppRailSettingsState): number {
  return selectAppRailVisible(state) ? APP_RAIL_WIDTH : 0
}

/** Pages that live on the rail below Workspaces, in this order. With the rail on, each fills the page and hides the list. */
export const APP_RAIL_DESTINATION_IDS = [
  'tasks',
  'automations',
  'artifacts',
  'skills',
  'plugins',
  'mobile'
] as const
export type AppRailDestinationId = (typeof APP_RAIL_DESTINATION_IDS)[number]

type AppRailPageState = AppRailSettingsState & Pick<UISlice, 'activeView'>

/** A rail destination is open with the rail on: the page fills the width and the workspace list body collapses. */
export function selectRailPageHidesWorkspaceList(state: AppRailPageState): boolean {
  return (
    selectAppRailVisible(state) && APP_RAIL_DESTINATION_IDS.some((id) => id === state.activeView)
  )
}

/**
 * Whether the workspace list is shown. Only layout reads this; the saved `sidebarOpen` is never written for a rail
 * page, so leaving the page restores exactly what the user chose.
 */
export function selectWorkspaceListOpen(
  state: AppRailPageState & Pick<UISlice, 'sidebarOpen'>
): boolean {
  return state.sidebarOpen && !selectRailPageHidesWorkspaceList(state)
}
