import {
  isEphemeralVmRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentSource
} from './runtime-environments'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-file'

/** Refuses replacing or removing a pairing that SSH access or a managed deployment depends on. */
export function assertNoIndependentSshAccess(environment: KnownRuntimeEnvironment): void {
  if (environment.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Orca runs this server on an SSH host for you; its pairing cannot be replaced or removed here. To decommission it, run `orca environment stop --environment <name> --yes` or use Settings > Orca on your SSH hosts; for a host that is gone, run `orca environment forget --environment <name> --yes`.'
    )
  }
  if (environment.pendingSshAccessOperation) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      "This server's SSH access change didn't finish. Retry or cancel it under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it."
    )
  }
  if (environment.sshAccess) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      "Unlink this server's SSH access under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it."
    )
  }
}

/** Refuses folding a new code into a saved server that another flow owns, naming that server. */
export function assertPairingReplaceableByAdd(
  environment: KnownRuntimeEnvironment,
  source: RuntimeEnvironmentSource | undefined,
  refreshable: boolean
): void {
  const alreadyPaired = `This server is already paired as "${environment.name}".`
  // Why: a cloud workspace pairs its own server on resume; a hand-made pairing would be swept with it.
  if (isEphemeralVmRuntimeEnvironment(environment)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `${alreadyPaired} It belongs to a cloud workspace, which pairs it again when it resumes.`
    )
  }
  if (source === 'ephemeral-vm') {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `${alreadyPaired} The cloud workspace's server reuses that server's identity, so it was not saved.`
    )
  }
  if (environment.orcadDeployment?.kind === 'wsl') {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `${alreadyPaired} Orca manages it as a WSL host, so its pairing cannot be replaced here.`
    )
  }
  try {
    assertNoIndependentSshAccess(environment)
  } catch (error) {
    throw error instanceof RuntimeEnvironmentStoreError
      ? new RuntimeEnvironmentStoreError(error.code, `${alreadyPaired} ${error.message}`)
      : error
  }
  // Why: only the app holding this server's connections can switch them to a new pairing.
  if (!refreshable) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `${alreadyPaired} To update its connection, add it again under Settings > Remote Orca Servers.`
    )
  }
}
