import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getPeerCollabOverviewSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.peer-collab.settings.search.title',
      'Peer Collaboration'
    ),
    description: translate(
      'auto.components.settings.peer-collab.settings.search.description',
      'Share terminals with other Orca desktops over your local network.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.peer',
        'peer'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.collab',
        'collaboration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.desktop',
        'desktop'
      ),
      ...translateSearchKeyword('auto.components.settings.peer-collab.settings.search.lan', 'lan'),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.share',
        'share'
      ),
      ...translateSearchKeyword('auto.components.settings.peer-collab.settings.search.qr', 'qr'),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.code',
        'code'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.client',
        'client'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.terminal',
        'terminal'
      )
    ]
  })
)

export const getPeerCollabClientSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.peer-collab.settings.search.clientTitle',
      'Connect to another Orca'
    ),
    description: translate(
      'auto.components.settings.peer-collab.settings.search.clientDescription',
      'Connect to a host Orca as a client using a pairing code.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.connect',
        'connect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.pairingCode',
        'pairing code'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.peer-collab.settings.search.clientRole',
        'client'
      )
    ]
  })
)

export const getPeerCollabSettingsPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    getPeerCollabOverviewSearchEntry(),
    getPeerCollabClientSearchEntry()
  ]
)
