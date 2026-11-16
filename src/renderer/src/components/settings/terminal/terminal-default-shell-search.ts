import type { SettingsSearchEntry } from '../search/settings-search'
import { searchKeywordTranslator } from '../search/settings-search-keywords'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getTerminalDefaultShellSearchEntry(t: Translate = translate): SettingsSearchEntry {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t('auto.components.settings.TerminalPane.9589abc009', 'Default shell'),
    description: t(
      'auto.components.settings.TerminalPane.1c29734248',
      'Shell used for new terminal panes'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.TerminalPane.a909136b3f', 'shell'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.81694f1584', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.0cbe5ad727', 'fish'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.c9bc93d343', 'zsh'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.17ad899ba4', 'bash'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.d469840b75', 'nushell'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.ddc72a4860', 'default'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.af893aa433', 'arguments'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.44f8a56f66', 'args'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.4faf688f78', 'login'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.73c211e979', 'wrapper'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.c2ddb189e7', 'rcfile')
    ]
  }
}
