import type { SettingsSearchEntry } from './settings-search'

export const MOBILE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Mobile Pairing',
    description: 'Pair a mobile device by scanning a QR code.',
    keywords: ['mobile', 'qr', 'code', 'pair', 'phone', 'scan']
  },
  {
    title: 'Connected Devices',
    description: 'Manage paired mobile devices.',
    keywords: ['mobile', 'devices', 'revoke', 'paired', 'connected']
  },
  {
    title: 'Network Interface',
    description: 'Choose which network address to use for mobile pairing.',
    keywords: [
      'network',
      'interface',
      'tailscale',
      'tailnet',
      'vpn',
      'overlay',
      'ip',
      'address',
      'wifi',
      'lan',
      'remote'
    ]
  },
  {
    title: 'When you leave the mobile app',
    description:
      'Choose what happens to terminals you were viewing on mobile after you close the app or switch away.',
    keywords: [
      'mobile',
      'terminal',
      'restore',
      'phone',
      'fit',
      'width',
      'resize',
      'hold',
      'leave',
      'background',
      'close'
    ]
  }
]
