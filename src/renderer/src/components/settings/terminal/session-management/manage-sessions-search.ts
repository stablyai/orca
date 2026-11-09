import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getManageSessionsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.6f5d486a68', 'Manage Sessions'),
    description: translate(
      'auto.components.settings.terminal.search.f72abc493c',
      'Recover from frozen terminals by killing sessions, clearing saved scrollback, or restarting the daemon.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f35400f7e8', 'daemon'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.9f2dda133c', 'pty'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d802a578bf', 'sessions'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a8d2784214', 'manage'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a3e5297c10', 'kill'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.920573d65b', 'kill all'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.456da64d4d', 'clear'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.3982d88725', 'history'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.cde233f5da',
        'scrollback'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6892fb1019', 'restart'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0a05629060', 'recover'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.88561b3499', 'frozen'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d4daf4f612', 'unfreeze')
    ]
  }
])
