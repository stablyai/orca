import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getRexBackendSearchEntry(t: Translate = translate): SettingsSearchEntry {
  return {
    title: t('settings.terminal.rexBackend.title', 'Terminal backend (experimental)'),
    description: t(
      'settings.terminal.rexBackend.description',
      'Rex requires a running local Rex Server and the approved Ghostty WASM artifact. Only supported new local terminals use Rex; existing sessions keep their backend.'
    ),
    keywords: [t('settings.terminal.rexBackend.rex', 'Rex')]
  }
}
