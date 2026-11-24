import { translate } from '@/i18n/i18n'
import {
  REMOTE_SERVER_PAIRING_FAILURE_COPY,
  type RemoteServerPairingFailureCode
} from '../../../../shared/remote-runtime/pairing/remote-server-pairing-failure-copy'

// null = required server name missing; caller shows the host's English `message`.
const COPY: Record<RemoteServerPairingFailureCode, (name: string | null) => string | null> = {
  invalidPairingCode: () =>
    translate(
      'runtime.remoteServerPairingErrors.invalidPairingCode',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.invalidPairingCode
    ),
  selfPairingCode: () =>
    translate(
      'runtime.remoteServerPairingErrors.selfPairingCode',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.selfPairingCode
    ),
  managedDeployment: () =>
    translate(
      'runtime.remoteServerPairingErrors.managedDeployment',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.managedDeployment
    ),
  sshAccessChangePending: () =>
    translate(
      'runtime.remoteServerPairingErrors.sshAccessChangePending',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.sshAccessChangePending
    ),
  sshAccessLinked: () =>
    translate(
      'runtime.remoteServerPairingErrors.sshAccessLinked',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.sshAccessLinked
    ),
  alreadyPairedCloudWorkspace: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedCloudWorkspace',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedCloudWorkspace,
          { name }
        ),
  alreadyPairedCloudIdentity: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedCloudIdentity',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedCloudIdentity,
          { name }
        ),
  alreadyPairedWslHost: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedWslHost',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedWslHost,
          {
            name
          }
        ),
  alreadyPairedManagedDeployment: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedManagedDeployment',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedManagedDeployment,
          { name }
        ),
  alreadyPairedSshAccessChangePending: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedSshAccessChangePending',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedSshAccessChangePending,
          { name }
        ),
  alreadyPairedSshAccessLinked: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedSshAccessLinked',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedSshAccessLinked,
          { name }
        ),
  alreadyPairedAddAgain: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedAddAgain',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedAddAgain,
          {
            name
          }
        ),
  alreadyPairedUnreadable: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.alreadyPairedUnreadable',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.alreadyPairedUnreadable,
          { name }
        ),
  nameTaken: (name) =>
    name === null
      ? null
      : translate(
          'runtime.remoteServerPairingErrors.nameTaken',
          REMOTE_SERVER_PAIRING_FAILURE_COPY.nameTaken,
          {
            name
          }
        ),
  idNeedsNewerOrca: () =>
    translate(
      'runtime.remoteServerPairingErrors.idNeedsNewerOrca',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.idNeedsNewerOrca
    ),
  hostSaveFailed: () =>
    translate(
      'runtime.remoteServerPairingErrors.hostSaveFailed',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.hostSaveFailed
    ),
  repairSaveFailed: () =>
    translate(
      'runtime.remoteServerPairingErrors.repairSaveFailed',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.repairSaveFailed
    ),
  repairCloudWorkspace: () =>
    translate(
      'runtime.remoteServerPairingErrors.repairCloudWorkspace',
      REMOTE_SERVER_PAIRING_FAILURE_COPY.repairCloudWorkspace
    )
}

function isRemoteServerPairingFailureCode(code: unknown): code is RemoteServerPairingFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** A pairing save failure in the UI language; uncoded (older host) or unknown codes show the English `message`. */
export function remoteServerPairingFailureMessage(failure: {
  message: string
  errorCode?: unknown
  errorParams?: unknown
}): string {
  if (!isRemoteServerPairingFailureCode(failure.errorCode)) {
    return failure.message
  }
  const params =
    typeof failure.errorParams === 'object' && failure.errorParams !== null
      ? failure.errorParams
      : {}
  const name = 'name' in params && typeof params.name === 'string' ? params.name : null
  return COPY[failure.errorCode](name) ?? failure.message
}
