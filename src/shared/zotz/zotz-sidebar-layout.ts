import type { ZotzGlobalSettings } from './zotz-global-settings-types'

/** The simple project list is the default; only an explicit 'orca' restores upstream's cards. */
export function isZotzConductorSidebar(
  settings: Pick<ZotzGlobalSettings, 'zotzSidebarLayout'> | null | undefined
): boolean {
  return settings?.zotzSidebarLayout !== 'orca'
}
