import { translate } from '@/i18n/i18n'
import type { ZcodePlanSite } from '../../../../shared/zcode-plan-sites'
import type { ProviderUsageWindowKind } from './provider-usage-windows'

export const ZCODE_PLAN_SEARCH_KEYWORDS = [
  'glm',
  'zai',
  'z.ai',
  'zhipu',
  'bigmodel',
  'coding plan',
  'usage',
  'rate limit',
  'zcode'
]

export function zcodeSiteLabel(site: ZcodePlanSite): string {
  if (site === 'bigmodel') {
    return translate(
      'auto.components.settings.ZcodePlanAccountsSection.site.bigmodel',
      'Zhipu · BigModel (open.bigmodel.cn)'
    )
  }
  return translate('auto.components.settings.ZcodePlanAccountsSection.site.zai', 'Z.AI (z.ai)')
}

// Why a function, not a module-level map: the labels must resolve on each render
// so switching the interface language updates them.
export function zcodeWindowLabel(kind: ProviderUsageWindowKind): string {
  if (kind === 'session') {
    return translate('auto.components.settings.ZcodePlanAccountsSection.window.session', '5 hours')
  }
  if (kind === 'weekly') {
    return translate('auto.components.settings.ZcodePlanAccountsSection.window.weekly', 'Weekly')
  }
  return translate('auto.components.settings.ZcodePlanAccountsSection.window.mcp', 'MCP monthly')
}
