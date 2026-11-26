// A catalog app's URL-blank words in the user's language; the vendors' site codes stay as they are.
import type { useTranslate } from '@/i18n/use-translate'
import type { BotMcpAppSite, BotMcpAppUrlVariable } from '../../../../../shared/bots/bot-mcp-apps'

type Translate = ReturnType<typeof useTranslate>

/** The field's label; an app this file doesn't know keeps the catalog's English. */
export function urlVariableLabel(
  t: Translate,
  appId: string,
  variable: BotMcpAppUrlVariable
): string {
  switch (appId) {
    case 'datadog':
      return t('bots.apps.mcp.datadog.siteLabel', 'Datadog site')
    case 'intercom':
      return t('bots.apps.mcp.intercom.siteLabel', 'Intercom region')
    case 'gitlab':
      return t('bots.apps.mcp.gitlab.hostLabel', 'GitLab address (optional)')
    default:
      return variable.label
  }
}

export function urlVariableHint(t: Translate, appId: string, hint: string): string {
  return appId === 'gitlab'
    ? t(
        'bots.apps.mcp.gitlab.hostHint',
        'For self-managed or Dedicated. Leave empty for GitLab.com.'
      )
    : hint
}

export function sitePlace(t: Translate, site: BotMcpAppSite): string {
  switch (site.place) {
    case 'United States':
      return t('bots.apps.mcp.place.unitedStates', 'United States')
    case 'US East':
      return t('bots.apps.mcp.place.usEast', 'US East')
    case 'US West':
      return t('bots.apps.mcp.place.usWest', 'US West')
    case 'US Central':
      return t('bots.apps.mcp.place.usCentral', 'US Central')
    case 'Europe':
      return t('bots.apps.mcp.place.europe', 'Europe')
    case 'Japan':
      return t('bots.apps.mcp.place.japan', 'Japan')
    case 'Australia':
      return t('bots.apps.mcp.place.australia', 'Australia')
    case 'United Kingdom':
      return t('bots.apps.mcp.place.unitedKingdom', 'United Kingdom')
    default:
      return site.place
  }
}
