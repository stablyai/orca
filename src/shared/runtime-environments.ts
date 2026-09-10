import { z } from 'zod'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import { PAIRING_OFFER_TUNNEL_VERSION, PairingTunnelSchema } from './mobile-relay-pairing-offer'

// Why loose: a newer Orca may persist endpoint fields this build does not know; a read-modify-write
// must carry them through instead of silently erasing them.
export const RuntimeAccessEndpointSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.literal('websocket'),
  label: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  tunnel: PairingTunnelSchema.optional()
})

export const RuntimeConnectionDependencySchema = z.enum(['ssh-tunnel', 'tailcat'])
export type RuntimeConnectionDependency = z.infer<typeof RuntimeConnectionDependencySchema>

export const PublicRuntimeAccessEndpointSchema = RuntimeAccessEndpointSchema.omit({
  deviceToken: true,
  publicKeyB64: true
})

export type PublicRuntimeAccessEndpoint = z.infer<typeof PublicRuntimeAccessEndpointSchema>

export const RuntimeEnvironmentSourceSchema = z.enum(['manual', 'ephemeral-vm'])
export type RuntimeEnvironmentSource = z.infer<typeof RuntimeEnvironmentSourceSchema>

export const KnownRuntimeEnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  pairingRevision: z.number().finite().optional(),
  pairedDeviceId: z.string().min(1).optional(),
  lastUsedAt: z.number().finite().nullable(),
  runtimeId: z.string().min(1).nullable(),
  source: RuntimeEnvironmentSourceSchema.optional(),
  connectionDependency: RuntimeConnectionDependencySchema.optional(),
  endpoints: z.array(RuntimeAccessEndpointSchema).min(1),
  preferredEndpointId: z.string().min(1)
})

export type KnownRuntimeEnvironment = z.infer<typeof KnownRuntimeEnvironmentSchema>

export type PublicKnownRuntimeEnvironment = Omit<KnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: PublicRuntimeAccessEndpoint[]
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

// Why: version 2 marks a store holding tunnel endpoints. Builds that predate tunnels accept only
// version 1 and refuse the file, which beats reading it, dropping the tunnel, and writing it back.
export const RUNTIME_ENVIRONMENT_STORE_VERSION = 1
export const RUNTIME_ENVIRONMENT_STORE_TUNNEL_VERSION = 2
export const RuntimeEnvironmentStoreSchema = z.object({
  version: z.union([
    z.literal(RUNTIME_ENVIRONMENT_STORE_VERSION),
    z.literal(RUNTIME_ENVIRONMENT_STORE_TUNNEL_VERSION)
  ]),
  environments: z.array(KnownRuntimeEnvironmentSchema)
})

export function runtimeEnvironmentStoreVersionFor(
  environments: readonly KnownRuntimeEnvironment[]
): 1 | 2 {
  return environments.some((environment) => environment.endpoints.some((entry) => entry.tunnel))
    ? RUNTIME_ENVIRONMENT_STORE_TUNNEL_VERSION
    : RUNTIME_ENVIRONMENT_STORE_VERSION
}

export type RuntimeEnvironmentStore = z.infer<typeof RuntimeEnvironmentStoreSchema>

export function createEnvironmentFromPairingOffer(args: {
  id: string
  name: string
  now: number
  offer: PairingOffer
  runtimeId?: string | null
  source?: RuntimeEnvironmentSource
  connectionDependency?: RuntimeConnectionDependency
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
        publicKeyB64: args.offer.publicKeyB64,
        ...(args.offer.tunnel ? { tunnel: args.offer.tunnel } : {})
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

export function getPreferredPairingOffer(environment: KnownRuntimeEnvironment): PairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error(`Environment ${environment.name} has no access endpoints`)
  }
  return {
    v: endpoint.tunnel ? PAIRING_OFFER_TUNNEL_VERSION : PAIRING_OFFER_VERSION,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {}),
    ...(endpoint.tunnel ? { tunnel: endpoint.tunnel } : {})
  }
}
