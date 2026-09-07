import type {
  HostAccessLinkErrorKind,
  RemotePairingEndpointKind
} from '../../../shared/remote-pairing-address'
import type { RemotePairingFailureKind } from '../../../shared/remote-pairing-verification'
import { translate } from '@/i18n/i18n'

export function translateHostAccessLinkError(kind: HostAccessLinkErrorKind): string {
  switch (kind) {
    case 'invalid-input':
      return translate(
        'auto.lib.remotePairingCopy.invalidInput',
        'Enter an Orca access link or bare pairing code.'
      )
    case 'mobile-only':
      return translate(
        'auto.lib.remotePairingCopy.mobileOnly',
        'This link grants mobile-only access. Generate a link for another Orca client.'
      )
    case 'invalid-destination':
      return translate(
        'auto.lib.remotePairingCopy.invalidDestination',
        'This access link contains an invalid destination.'
      )
    case 'unsupported-destination':
      return translate(
        'auto.lib.remotePairingCopy.unsupportedDestination',
        'This access link contains an unsupported destination.'
      )
    case 'non-connectable-destination':
      return translate(
        'auto.lib.remotePairingCopy.nonConnectableDestination',
        'This access link contains a non-connectable destination.'
      )
  }
}

export function translateRemotePairingEndpointKind(kind: RemotePairingEndpointKind): string {
  switch (kind) {
    case 'loopback':
      return translate('auto.lib.remotePairingCopy.loopback', 'Loopback')
    case 'tailscale':
      return translate('auto.lib.remotePairingCopy.tailscale', 'Tailscale address')
    case 'lan':
      return translate('auto.lib.remotePairingCopy.lan', 'Private LAN address')
    case 'public':
      return translate('auto.lib.remotePairingCopy.public', 'Public address')
    case 'custom':
      return translate('auto.lib.remotePairingCopy.custom', 'Custom hostname')
  }
}

export function translateRemotePairingFailureDescription(
  kind: RemotePairingFailureKind,
  endpoint: string | null
): string {
  switch (kind) {
    case 'host-identity-mismatch':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.identityMismatchHelp',
        'Orca reached {{endpoint}}, but that host does not match this link. Generate a new link on the other host.',
        { endpoint: endpoint ?? 'Orca' }
      )
    case 'access-link-invalid':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.invalidLinkHelp',
        'Generate a new access link on the other host and try again.'
      )
    case 'protocol-incompatible':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.incompatibleHelp',
        'Update Orca on this device and the other host, then try again.'
      )
    case 'connection-interrupted':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.interruptedHelp',
        'The connection stopped during verification. Check the network or SSH tunnel and try again.'
      )
    case 'environment-save-failed':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.saveFailedHelp',
        'The host was verified, but Orca could not save it. Check the name and local settings storage, then try again.'
      )
    case 'host-unreachable':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.unavailableHelp',
        'Make sure Orca is running on the other host and that the network or SSH tunnel can reach {{endpoint}}.',
        { endpoint: endpoint ?? 'Orca' }
      )
  }
}
