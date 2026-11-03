import { translate } from '@/i18n/i18n'
import type { LoadedMcpConfigInspection } from './McpConfigFileRow'

export function formatMcpConfigSummary(configs: LoadedMcpConfigInspection[]): string {
  const detected = configs.filter((config) => config.exists).length
  const count = configs.reduce((sum, config) => sum + config.servers.length, 0)
  return translate(
    'auto.components.settings.McpConfigSection.detectedServers',
    '{{detected}} detected · {{count}} servers',
    { detected, count, defaultValue_one: '{{detected}} detected · {{count}} server' }
  )
}
