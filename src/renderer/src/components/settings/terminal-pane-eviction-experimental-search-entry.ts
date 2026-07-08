import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getTerminalPaneEvictionExperimentalSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.terminalPaneEviction.title',
      'Free memory from hidden terminals'
    ),
    description: translate(
      'auto.components.settings.experimental.search.terminalPaneEviction.description',
      'Unmounts terminal panes you have not looked at recently and restores them on demand, keeping heavy multi-agent workspaces fast. Their processes keep running.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalPaneEviction.terminal',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalPaneEviction.pane',
        'pane'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalPaneEviction.memory',
        'memory'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalPaneEviction.performance',
        'performance'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalPaneEviction.evict',
        'evict'
      )
    ]
  }
}
