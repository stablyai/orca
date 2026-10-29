import { classifyRemotePairingHostname } from '../../../../shared/remote-pairing-address'
import { translate } from '@/i18n/i18n'

/** "Tailscale · 100.x.y.z" instead of the interface name ("utun6"), which means nothing to most people. */
export function describeNetworkAddress(interfaceName: string, address: string): string {
  switch (classifyRemotePairingHostname(address)) {
    case 'tailscale':
      return translate(
        'auto.components.settings.networkAddress.tailscale',
        'Tailscale · {{address}}',
        {
          address
        }
      )
    case 'lan':
      return translate(
        'auto.components.settings.networkAddress.lan',
        'Local network · {{address}}',
        {
          address
        }
      )
    case 'loopback':
      return translate(
        'auto.components.settings.networkAddress.loopback',
        'This computer · {{address}}',
        {
          address
        }
      )
    case 'public':
    case 'custom':
      return `${interfaceName} · ${address}`
  }
}
