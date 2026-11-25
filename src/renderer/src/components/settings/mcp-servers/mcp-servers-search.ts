import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../search/settings-search-keywords'

export function getMcpServersPaneSearchEntries(t: Translate = translate): SettingsSearchEntry[] {
  const keyword = searchKeywordTranslator(t)
  return [
    {
      title: t('settings.mcpServers.title', 'MCP servers'),
      description: t(
        'settings.mcpServers.description',
        'Servers your agents can use. Changes apply to new sessions.'
      ),
      keywords: [
        ...keyword('settings.mcpServers.search.mcp', 'mcp'),
        ...keyword('settings.mcpServers.search.protocol', 'model context protocol'),
        ...keyword('settings.mcpServers.search.tools', 'tools'),
        ...keyword('settings.mcpServers.search.servers', 'servers')
      ]
    }
  ]
}
