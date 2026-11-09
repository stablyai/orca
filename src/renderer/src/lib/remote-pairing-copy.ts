import type {
  HostAccessLinkErrorKind,
  RemotePairingEndpointKind
} from '../../../shared/remote-runtime/pairing/remote-pairing-address'
import type { RemotePairingFailureKind } from '../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function translateHostAccessLinkError(
  kind: HostAccessLinkErrorKind,
  t: Translate = translate
): string {
  switch (kind) {
    case 'invalid-input':
      return t(
        'auto.lib.remotePairingCopy.invalidInput',
        'Enter an Orca access link or bare pairing code.'
      )
    case 'mobile-only':
      return t(
        'auto.lib.remotePairingCopy.mobileOnly',
        'This link grants mobile-only access. Generate a link for another Orca client.'
      )
    case 'invalid-destination':
      return t(
        'auto.lib.remotePairingCopy.invalidDestination',
        'This access link contains an invalid destination.'
      )
    case 'unsupported-destination':
      return t(
        'auto.lib.remotePairingCopy.unsupportedDestination',
        'This access link contains an unsupported destination.'
      )
    case 'non-connectable-destination':
      return t(
        'auto.lib.remotePairingCopy.nonConnectableDestination',
        'This access link contains a non-connectable destination.'
      )
  }
}

export function translateRemotePairingEndpointKind(
  kind: RemotePairingEndpointKind,
  t: Translate = translate
): string {
  switch (kind) {
    case 'loopback':
      return t('auto.lib.remotePairingCopy.loopback', 'Loopback')
    case 'tailscale':
      return t('auto.lib.remotePairingCopy.tailscale', 'Tailscale address')
    case 'lan':
      return t('auto.lib.remotePairingCopy.lan', 'Private LAN address')
    case 'public':
      return t('auto.lib.remotePairingCopy.public', 'Public address')
    case 'custom':
      return t('auto.lib.remotePairingCopy.custom', 'Custom hostname')
  }
}

export function translateRemotePairingFailureDescription(
  kind: RemotePairingFailureKind,
  endpoint: string | null,
  t: Translate = translate
): string {
  switch (kind) {
    case 'host-identity-mismatch':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.identityMismatchHelp',
        'Orca reached {{endpoint}}, but that host does not match this link. Generate a new link on the other host.',
        { endpoint: endpoint ?? 'Orca' }
      )
    case 'access-link-invalid':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.invalidLinkHelp',
        'Generate a new access link on the other host and try again.'
      )
    case 'protocol-incompatible':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.incompatibleHelp',
        'Update Orca on this device and the other host, then try again.'
      )
    case 'connection-interrupted':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.interruptedHelp',
        'The connection stopped during verification. Check the network or SSH tunnel and try again.'
      )
    case 'environment-save-failed':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.saveFailedHelp',
        'The host was verified, but Orca could not save it. Check the name and local settings storage, then try again.'
      )
    case 'different-server':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.differentServerHelp',
        'This pairing link is for a different server. Create the link on the server you are re-pairing.'
      )
    case 'host-unreachable':
      return t(
        'auto.components.settings.RuntimeHostAccessForm.unavailableHelp',
        'Make sure Orca is running on the other host and that the network or SSH tunnel can reach {{endpoint}}.',
        { endpoint: endpoint ?? 'Orca' }
      )
  }
}
