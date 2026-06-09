import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getMobilePaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.mobile.pane.search.d49925710a', 'Mobile Pairing'),
    description: translate(
      'auto.components.settings.mobile.pane.search.7fb728fb2b',
      'Pair a mobile device by scanning a QR code.'
    ),
    keywords: [
      translate('auto.components.settings.mobile.pane.search.6db86f445f', 'mobile'),
      translate('auto.components.settings.mobile.pane.search.3c1807a81a', 'qr'),
      translate('auto.components.settings.mobile.pane.search.4a0c826f3d', 'code'),
      translate('auto.components.settings.mobile.pane.search.e518cbd61c', 'pair'),
      translate('auto.components.settings.mobile.pane.search.ad08035c5f', 'phone'),
      translate('auto.components.settings.mobile.pane.search.2128a21096', 'scan')
    ]
  },
  {
    title: translate('auto.components.settings.mobile.pane.search.9d3a9397ba', 'Connected Devices'),
    description: translate(
      'auto.components.settings.mobile.pane.search.13419718b3',
      'Manage paired mobile devices.'
    ),
    keywords: [
      translate('auto.components.settings.mobile.pane.search.6db86f445f', 'mobile'),
      translate('auto.components.settings.mobile.pane.search.82783d9b71', 'devices'),
      translate('auto.components.settings.mobile.pane.search.905c65a308', 'revoke'),
      translate('auto.components.settings.mobile.pane.search.5e8fda4d7f', 'paired'),
      translate('auto.components.settings.mobile.pane.search.7d01f93ec0', 'connected')
    ]
  },
  {
    title: translate('auto.components.settings.mobile.pane.search.d96c315227', 'Network Interface'),
    description: translate(
      'auto.components.settings.mobile.pane.search.3190ef67a4',
      'Choose which network address to use for mobile pairing.'
    ),
    keywords: [
      translate('auto.components.settings.mobile.pane.search.7b37c2e557', 'network'),
      translate('auto.components.settings.mobile.pane.search.a023683767', 'interface'),
      translate('auto.components.settings.mobile.pane.search.c690e3ee38', 'tailscale'),
      translate('auto.components.settings.mobile.pane.search.16bff559a0', 'tailnet'),
      translate('auto.components.settings.mobile.pane.search.87711f4b8f', 'vpn'),
      translate('auto.components.settings.mobile.pane.search.d0c89bc4a9', 'overlay'),
      translate('auto.components.settings.mobile.pane.search.1f70d63998', 'ip'),
      translate('auto.components.settings.mobile.pane.search.dd6e671aa9', 'address'),
      translate('auto.components.settings.mobile.pane.search.1802188b5d', 'wifi'),
      translate('auto.components.settings.mobile.pane.search.70f505f3c3', 'lan'),
      translate('auto.components.settings.mobile.pane.search.126afc5dbd', 'remote')
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
      translate('auto.components.settings.mobile.pane.search.6db86f445f', 'mobile'),
      translate('auto.components.settings.mobile.pane.search.b34ad5b3a7', 'terminal'),
      translate('auto.components.settings.mobile.pane.search.6cd2bfdb0e', 'restore'),
      translate('auto.components.settings.mobile.pane.search.ad08035c5f', 'phone'),
      translate('auto.components.settings.mobile.pane.search.fadcbfdd99', 'fit'),
      translate('auto.components.settings.mobile.pane.search.356c31d6dc', 'width'),
      translate('auto.components.settings.mobile.pane.search.aa3f736042', 'resize'),
      translate('auto.components.settings.mobile.pane.search.8015fd9523', 'hold'),
      translate('auto.components.settings.mobile.pane.search.3a5e31e84b', 'leave'),
      translate('auto.components.settings.mobile.pane.search.9e16be01d6', 'background'),
      translate('auto.components.settings.mobile.pane.search.dbccde3a60', 'close')
    ]
  }
])
