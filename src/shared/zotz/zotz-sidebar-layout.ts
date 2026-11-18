import type { ZotzGlobalSettings } from './zotz-global-settings-types'

/** The simple project list is the default; 'orca' restores upstream's cards, as does an unset layout under e2e. */
export function isZotzConductorSidebar(
  settings: Pick<ZotzGlobalSettings, 'zotzSidebarLayout'> | null | undefined,
  automatedLaunch = false
): boolean {
  const layout = settings?.zotzSidebarLayout
  return layout === 'conductor' || (layout !== 'orca' && !automatedLaunch)
}
