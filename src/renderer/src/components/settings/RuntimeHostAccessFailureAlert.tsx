import type {
  RemotePairingFailure,
  RemotePairingFailureKind
} from '../../../../shared/remote-pairing-verification'
import { translate } from '@/i18n/i18n'
import { translateRemotePairingFailureDescription } from '@/lib/remote-pairing-copy'
import { remoteServerPairingFailureMessage } from '@/lib/remote-server-pairing-error-copy'

export type RuntimeHostAccessFailure = Omit<RemotePairingFailure, 'ok'>

function failureTitle(kind: RemotePairingFailureKind): string {
  switch (kind) {
    case 'host-identity-mismatch':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.identityMismatch',
        'The reached Orca host does not match this access link'
      )
    case 'access-link-invalid':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.invalidLink',
        'This access link is no longer valid'
      )
    case 'protocol-incompatible':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.incompatible',
        'Orca versions are not compatible'
      )
    case 'connection-interrupted':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.interrupted',
        'Connection interrupted'
      )
    case 'environment-save-failed':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.saveFailed',
        'Could not save the host'
      )
    case 'different-server':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.differentServer',
        'This link is for a different server'
      )
    case 'host-unreachable':
      return translate(
        'auto.components.settings.RuntimeHostAccessForm.unavailable',
        'Host unavailable'
      )
  }
}

export function RuntimeHostAccessFailureAlert({
  id,
  failure,
  endpoint
}: {
  id: string
  failure: RuntimeHostAccessFailure
  endpoint: string | null
}): React.JSX.Element {
  return (
    <div id={id} role="alert" className="space-y-1 rounded-md border border-destructive/50 p-3">
      <div className="text-sm font-medium text-destructive">{failureTitle(failure.kind)}</div>
      <p className="text-xs text-muted-foreground">
        {failure.kind === 'environment-save-failed'
          ? remoteServerPairingFailureMessage(failure)
          : translateRemotePairingFailureDescription(failure.kind, endpoint)}
      </p>
    </div>
  )
}
