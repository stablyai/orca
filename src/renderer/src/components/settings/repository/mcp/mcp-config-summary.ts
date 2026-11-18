import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { LoadedMcpConfigInspection } from '../../../../runtime/mcp/configuration/mcp-config-inspection'

export function formatMcpConfigSummary(
  configs: LoadedMcpConfigInspection[],
  t: Translate = translate
): string {
  const detected = configs.filter((config) => config.exists).length
  const count = configs.reduce((sum, config) => sum + config.servers.length, 0)
  return t(
    'auto.components.settings.McpConfigSection.detectedServers',
    '{{detected}} detected · {{count}} servers',
    { detected, count, defaultValue_one: '{{detected}} detected · {{count}} server' }
  )
}
