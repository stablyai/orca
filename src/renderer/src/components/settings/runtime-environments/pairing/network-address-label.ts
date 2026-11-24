import { classifyRemotePairingHostname } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** "Tailscale · 100.x.y.z" instead of the interface name ("utun6"), which means nothing to most people. */
export function describeNetworkAddress(
  interfaceName: string,
  address: string,
  t: Translate = translate
): string {
  switch (classifyRemotePairingHostname(address)) {
    case 'tailscale':
      return t('auto.components.settings.networkAddress.tailscale', 'Tailscale · {{address}}', {
        address
      })
    case 'lan':
      return t('auto.components.settings.networkAddress.lan', 'Local network · {{address}}', {
        address
      })
    case 'loopback':
      return t('auto.components.settings.networkAddress.loopback', 'This computer · {{address}}', {
        address
      })
    case 'public':
    case 'custom':
      return `${interfaceName} · ${address}`
  }
}
