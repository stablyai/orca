import { classifyRemotePairingHostname } from './remote-pairing-address'
import type { PairingOffer } from './pairing'
import {
  RuntimeRelayConnectionSchema,
  type RuntimeRelayConnection
} from './runtime-relay-connection'
import type { PersistedRuntimeEnvironment } from './runtime-environments'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-file'
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'

export function assertRuntimeRelayVerified(
  offer: PairingOffer,
  relay?: RuntimeRelayConnection
): void {
  if (!offer.relay && !relay) {
    return
  }
  if (
    !offer.relay ||
    !relay ||
    relay.credentialKind !== 'resume' ||
    relay.relayHostId !== offer.relay.relayHostId ||
    relay.directorUrl !== offer.relay.directorUrl
  ) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Verify the Relay access code before saving this computer.'
    )
  }
  RuntimeRelayConnectionSchema.parse(relay)
}

export function stageRuntimeEnvironmentRelay(
  userDataPath: string,
  environments: readonly PersistedRuntimeEnvironment[],
  environment: PersistedRuntimeEnvironment,
  relay?: RuntimeRelayConnection,
  pending?: PersistedRuntimeEnvironment
): void {
  if (!relay) {
    return
  }
  const previous = pending
    ? readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, environment)
    : undefined
  writeRuntimeEnvironmentSidecarEntry(
    userDataPath,
    environments,
    environment,
    pending ? { ...previous, pendingRelayConnection: relay } : { relayConnection: relay },
    pending
  )
}

export function getPairingConnectionDependency(
  dependency: 'ssh-tunnel' | undefined,
  offer: PairingOffer
): { connectionDependency?: 'ssh-tunnel' } {
  if (!dependency) {
    return {}
  }
  try {
    const endpoint = new URL(offer.endpoint)
    return classifyRemotePairingHostname(endpoint.hostname) === 'loopback'
      ? { connectionDependency: dependency }
      : {}
  } catch {
    return {}
  }
}
