import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from './agent-catalog'

export function createReasonixAgentCatalogEntry(): AgentCatalogEntry {
  return {
    id: 'reasonix',
    label: translate('auto.lib.agent.catalog.reasonix_label', 'Reasonix'),
    cmd: 'reasonix',
    searchAliases: ['deepseek reasonix'],
    faviconDomain: 'esengine.github.io',
    homepageUrl: 'https://github.com/esengine/DeepSeek-Reasonix/tree/v1.39.7'
  }
}
