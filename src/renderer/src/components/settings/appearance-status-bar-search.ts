import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getUsageStatusBarToggles } from './status-bar-usage-toggles'
import { getPanelStatusBarToggles } from './status-bar-panel-toggles'

export const getStatusBarToggles = createLocalizedCatalog(() => [
  ...getUsageStatusBarToggles(),
  ...getPanelStatusBarToggles()
])
