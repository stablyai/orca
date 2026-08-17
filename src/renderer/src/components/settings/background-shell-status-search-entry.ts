import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBackgroundShellStatusSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.backgroundShellStatus.title',
      'Ignore background shells'
    ),
    description: translate(
      'auto.components.settings.experimental.search.backgroundShellStatus.description',
      'Background shells whose command never exits, such as dev servers and watchers, stop keeping an agent marked as working once its turn ends.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.background',
        'background'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.shell',
        'shell'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.devServer',
        'dev server'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.build',
        'build'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.status',
        'status'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.spinner',
        'spinner'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.backgroundShellStatus.working',
        'working'
      )
    ]
  }
}
