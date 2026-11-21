import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

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
