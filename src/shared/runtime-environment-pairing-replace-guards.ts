import {
  isEphemeralVmRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentSource
} from './runtime-environments'
import { alreadyPairedGuardCode } from './remote-server-pairing-failure-copy'
import {
  remoteServerPairingStoreError,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-records'

/** Refuses replacing or removing a pairing that SSH access or a managed deployment depends on. */
export function assertNoIndependentSshAccess(environment: KnownRuntimeEnvironment): void {
  if (environment.orcadDeployment) {
    throw remoteServerPairingStoreError('managedDeployment')
  }
  if (environment.pendingSshAccessOperation) {
    throw remoteServerPairingStoreError('sshAccessChangePending')
  }
  if (environment.sshAccess) {
    throw remoteServerPairingStoreError('sshAccessLinked')
  }
}

/** Refuses folding a new code into a saved server that another flow owns, naming that server. */
export function assertPairingReplaceableByAdd(
  environment: KnownRuntimeEnvironment,
  source: RuntimeEnvironmentSource | undefined,
  refreshable: boolean
): void {
  const named = { name: environment.name }
  // Why: a cloud workspace pairs its own server on resume; a hand-made pairing would be swept with it.
  if (isEphemeralVmRuntimeEnvironment(environment)) {
    throw remoteServerPairingStoreError('alreadyPairedCloudWorkspace', named)
  }
  if (source === 'ephemeral-vm') {
    throw remoteServerPairingStoreError('alreadyPairedCloudIdentity', named)
  }
  if (environment.orcadDeployment?.kind === 'wsl') {
    throw remoteServerPairingStoreError('alreadyPairedWslHost', named)
  }
  try {
    assertNoIndependentSshAccess(environment)
  } catch (error) {
    const pairedCode =
      error instanceof RuntimeEnvironmentStoreError && error.pairingFailure
        ? alreadyPairedGuardCode(error.pairingFailure.errorCode)
        : null
    throw pairedCode ? remoteServerPairingStoreError(pairedCode, named) : error
  }
  // Why: only the app holding this server's connections can switch them to a new pairing.
  if (!refreshable) {
    throw remoteServerPairingStoreError('alreadyPairedAddAgain', named)
  }
}
