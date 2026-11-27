import '../pairing/pairing'
import { PAIRING_OFFER_VERSION, type PairingOffer } from '../pairing/mobile-relay-pairing-offer'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../pairing/paired-runtime-connection'
import type { WslHostServerStop } from '../wsl-hosts/wsl-host-types'
import {
  KnownRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type OrcadDeploymentLink,
  type OrcadSshDeploymentLink,
  type OrcadWslDeploymentLink,
  type PublicRuntimeAccessEndpoint,
  type RuntimeEnvironmentSource,
  type RuntimeSshTunnelLink
} from './runtime-environment-schemas'

export {
  RuntimeAccessEndpointSchema,
  PublicRuntimeAccessEndpointSchema,
  RuntimeEnvironmentSourceSchema,
  RuntimeSshTunnelLinkSchema,
  OrcadSshDeploymentLinkSchema,
  OrcadDeploymentLinkSchema,
  RuntimeSshAccessLinkSchema,
  RuntimeSshAccessOperationSchema,
  PersistedRuntimeEnvironmentSchema,
  KnownRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  getPreferredLoopbackRuntimePort,
  type PublicRuntimeAccessEndpoint,
  type RuntimeEnvironmentSource,
  type RuntimeSshTunnelLink,
  type OrcadSshDeploymentLink,
  type OrcadDeploymentLink,
  type RuntimeSshAccessOperation,
  type PersistedRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentStore
} from './runtime-environment-schemas'

/** The managed deployment Orca owns over SSH; undefined for none or a WSL one. */
export function getOrcadSshDeployment(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): OrcadSshDeploymentLink | undefined {
  const deployment = environment.orcadDeployment
  return deployment && deployment.kind !== 'wsl' ? deployment : undefined
}

export type PublicKnownRuntimeEnvironment = Omit<KnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: PublicRuntimeAccessEndpoint[]
  /** Digest of the host's persisted E2EE public key, which its pairing handshake proves. */
  hostKeyFingerprint?: string
}

/** `serverStop` only for a host whose owning service stops a server (a WSL host, E11). */
export type RuntimeEnvironmentRemoval = {
  removed: PublicKnownRuntimeEnvironment
  serverStop?: WslHostServerStop
}

export function redactRuntimeEnvironment(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  return {
    ...environment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _deviceToken, publicKeyB64: _key, ...rest }) => rest
    )
  }
}

export function createEnvironmentFromPairingOffer(args: {
  id: string
  name: string
  now: number
  offer: PairingOffer
  runtimeId?: string | null
  source?: RuntimeEnvironmentSource
  connectionDependency?: 'ssh-tunnel'
}): KnownRuntimeEnvironment {
  const endpointId = `ws-${args.id}`
  return KnownRuntimeEnvironmentSchema.parse({
    id: args.id,
    name: args.name,
    createdAt: args.now,
    updatedAt: args.now,
    pairingRevision: args.now,
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    lastUsedAt: null,
    runtimeId: args.runtimeId ?? null,
    ...(args.source ? { source: args.source } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
    endpoints: [
      {
        id: endpointId,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: args.offer.endpoint,
        deviceToken: args.offer.deviceToken,
        publicKeyB64: args.offer.publicKeyB64
      }
    ],
    preferredEndpointId: endpointId
  })
}

export function isEphemeralVmRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source'>
): boolean {
  return environment.source === 'ephemeral-vm'
}

export function isUserManagedRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source'>
): boolean {
  return !isEphemeralVmRuntimeEnvironment(environment)
}

/** Only the user re-pairs these, with an access link; Orca pairs managed and cloud servers itself. */
export function isRepairableWithAccessLink(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source' | 'orcadDeployment'>
): boolean {
  return !environment.orcadDeployment && isUserManagedRuntimeEnvironment(environment)
}

/** Who pairs a server that refused this desktop: the user with a link, Orca over SSH, or Orca on Connect. */
export type RuntimePairingRepairRoute = 'access-link' | 'ssh' | 'connect'

export function runtimePairingRepairRoute(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source' | 'orcadDeployment'>
): RuntimePairingRepairRoute {
  if (getOrcadSshDeployment(environment)) {
    return 'ssh'
  }
  return isRepairableWithAccessLink(environment) ? 'access-link' : 'connect'
}

/** A WSL distro added as a host; keyed by its deployment record's kind, never by its name. */
export function isWslHostRuntimeEnvironment<
  T extends { orcadDeployment?: OrcadDeploymentLink | null }
>(environment: T): environment is T & { orcadDeployment: OrcadWslDeploymentLink } {
  return environment.orcadDeployment?.kind === 'wsl'
}

/**
 * A server the generic remote-server surfaces list (Settings, status bar, server updates):
 * neither a recipe VM nor a WSL host, which each have their own place.
 */
export function isListedRemoteServer(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source' | 'orcadDeployment'>
): boolean {
  return isUserManagedRuntimeEnvironment(environment) && !isWslHostRuntimeEnvironment(environment)
}

type PreferredEndpointSource = Pick<
  KnownRuntimeEnvironment,
  'name' | 'endpoints' | 'preferredEndpointId' | 'pairedDeviceId'
>

export function preferredEndpoint(environment: PreferredEndpointSource) {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error(`Environment ${environment.name} has no access endpoints`)
  }
  return endpoint
}

export function getPreferredPairedRuntimeConnection(
  environment: PreferredEndpointSource
): PairedRuntimeConnection {
  const endpoint = preferredEndpoint(environment)
  return pairedRuntimeConnectionFromOffer({
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    pairedDeviceId: environment.pairedDeviceId
  })
}

export function getPreferredPairingOffer(environment: PreferredEndpointSource): PairingOffer {
  const endpoint = preferredEndpoint(environment)
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
  }
}

/** The SSH tunnel a server is reached through; only orcadDeployment also grants lifecycle ownership. */
export function getRuntimeSshAccess(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'>
): RuntimeSshTunnelLink | undefined {
  return getOrcadSshDeployment(environment) ?? environment.sshAccess
}
