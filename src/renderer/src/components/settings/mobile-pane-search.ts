import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getMobilePaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.mobile.pane.search.d49925710a', 'Mobile Pairing'),
    description: translate(
      'auto.components.settings.mobile.pane.search.7fb728fb2b',
      'Pair a mobile device by scanning a QR code.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.6db86f445f', 'mobile'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.3c1807a81a', 'qr'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.4a0c826f3d', 'code'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.e518cbd61c', 'pair'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.ad08035c5f', 'phone'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.2128a21096', 'scan')
    ]
  },
  {
    title: translate('auto.components.settings.mobile.pane.search.9d3a9397ba', 'Connected Devices'),
    description: translate(
      'auto.components.settings.mobile.pane.search.13419718b3',
      'Manage paired mobile devices.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.6db86f445f', 'mobile'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.82783d9b71',
        'devices'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.905c65a308', 'revoke'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.5e8fda4d7f', 'paired'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.7d01f93ec0',
        'connected'
      )
    ]
  },
  {
    title: translate('auto.components.settings.mobile.pane.search.d96c315227', 'Network Interface'),
    description: translate(
      'auto.components.settings.mobile.pane.search.3190ef67a4',
      'Choose which network address to use for mobile pairing.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.7b37c2e557',
        'network'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.a023683767',
        'interface'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.c690e3ee38',
        'tailscale'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.16bff559a0',
        'tailnet'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.87711f4b8f', 'vpn'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.d0c89bc4a9',
        'overlay'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.1f70d63998', 'ip'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.dd6e671aa9',
        'address'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.1802188b5d', 'wifi'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.70f505f3c3', 'lan'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.126afc5dbd', 'remote')
    ]
  },
  {
    title: translate(
      'auto.components.settings.mobile.pane.search.1e711aca11',
      'When you leave the mobile app'
    ),
    description: translate(
      'auto.components.settings.mobile.pane.search.707fc78052',
      'Choose what happens to terminals you were viewing on mobile after you close the app or switch away.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.6db86f445f', 'mobile'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.b34ad5b3a7',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.6cd2bfdb0e',
        'restore'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.ad08035c5f', 'phone'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.fadcbfdd99', 'fit'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.356c31d6dc', 'width'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.aa3f736042', 'resize'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.8015fd9523', 'hold'),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.3a5e31e84b', 'leave'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.pane.search.9e16be01d6',
        'background'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.pane.search.dbccde3a60', 'close')
    ]
  }
])
