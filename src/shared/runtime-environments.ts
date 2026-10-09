import { z } from 'zod'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'

export const RuntimeAccessEndpointSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('websocket'),
  label: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1)
})

export const PublicRuntimeAccessEndpointSchema = RuntimeAccessEndpointSchema.omit({
  deviceToken: true,
  publicKeyB64: true
})

export type PublicRuntimeAccessEndpoint = z.infer<typeof PublicRuntimeAccessEndpointSchema>

export const RuntimeEnvironmentSourceSchema = z.enum(['manual', 'ephemeral-vm'])
export type RuntimeEnvironmentSource = z.infer<typeof RuntimeEnvironmentSourceSchema>

export const RuntimeSshTunnelLinkSchema = z.object({
  sshTargetId: z.string().min(1),
  sshTargetGeneration: z.number().int().positive(),
  localPort: z.number().int().min(1).max(65_535),
  remotePort: z.number().int().min(1).max(65_535)
})

export type RuntimeSshTunnelLink = z.infer<typeof RuntimeSshTunnelLinkSchema>

/** A server Orca deployed and owns over SSH; unlike sshAccess, it grants lifecycle ownership. */
export const OrcadDeploymentLinkSchema = RuntimeSshTunnelLinkSchema
export type OrcadDeploymentLink = RuntimeSshTunnelLink

export const RuntimeSshAccessLinkSchema = RuntimeSshTunnelLinkSchema.extend({
  requestId: z.string().min(1).optional(),
  targetFingerprint: z.string().min(1).optional(),
  endpointId: z.string().min(1),
  previousPreferredEndpointId: z.string().min(1)
})

export type RuntimeSshAccessLink = z.infer<typeof RuntimeSshAccessLinkSchema>

export const RuntimeSshAccessOperationSchema = RuntimeSshTunnelLinkSchema.omit({ localPort: true })
  .extend({
    requestId: z.string().min(1),
    operation: z.enum(['link', 'unlink']),
    targetFingerprint: z.string().min(1).optional()
  })
  .refine((intent) => intent.operation !== 'link' || !!intent.targetFingerprint, {
    message: 'Link intent requires a target fingerprint.'
  })

export type RuntimeSshAccessOperation = z.infer<typeof RuntimeSshAccessOperationSchema>

/** The fields shipped builds read and rewrite in orca-environments.json. */
export const PersistedRuntimeEnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  pairingRevision: z.number().finite().optional(),
  pairedDeviceId: z.string().min(1).optional(),
  lastUsedAt: z.number().finite().nullable(),
  runtimeId: z.string().min(1).nullable(),
  source: RuntimeEnvironmentSourceSchema.optional(),
  connectionDependency: z.literal('ssh-tunnel').optional(),
  endpoints: z.array(RuntimeAccessEndpointSchema).min(1),
  preferredEndpointId: z.string().min(1)
})

export type PersistedRuntimeEnvironment = z.infer<typeof PersistedRuntimeEnvironmentSchema>

/**
 * A persisted environment with its sidecar state overlaid (runtime-environment-sidecar). These
 * fields never enter orca-environments.json: shipped builds strip unknown keys when they rewrite it.
 */
export const KnownRuntimeEnvironmentSchema = PersistedRuntimeEnvironmentSchema.extend({
  sshAccess: RuntimeSshAccessLinkSchema.optional(),
  pendingSshAccessOperation: RuntimeSshAccessOperationSchema.optional(),
  orcadDeployment: OrcadDeploymentLinkSchema.optional(),
  /** When a migration into this managed server began committing; older snapshots predate it. */
  orcadMigratedAt: z.string().datetime().optional(),
  reconciliation: RuntimeEnvironmentReconciliationRecordSchema.optional()
})
  .refine(
    ({ pendingSshAccessOperation, sshAccess, orcadDeployment, connectionDependency }) =>
      !pendingSshAccessOperation || (!sshAccess && !orcadDeployment && !connectionDependency),
    {
      message: 'Pending SSH access operations cannot coexist with active SSH access.',
      path: ['pendingSshAccessOperation']
    }
  )
  .refine(
    (environment) => {
      const access = environment.sshAccess
      return (
        !access ||
        (environment.connectionDependency === 'ssh-tunnel' &&
          environment.preferredEndpointId === access.endpointId &&
          access.previousPreferredEndpointId !== access.endpointId &&
          environment.endpoints.some(
            (endpoint) => endpoint.id === access.previousPreferredEndpointId
          ) &&
          getPreferredLoopbackRuntimePort(environment) === access.localPort)
      )
    },
    {
      message:
        'Runtime SSH access must preserve its previous endpoint and prefer its loopback endpoint.',
      path: ['sshAccess']
    }
  )
  .refine(
    (environment) => {
      const deployment = environment.orcadDeployment
      return (
        !deployment ||
        (!environment.sshAccess &&
          environment.connectionDependency === 'ssh-tunnel' &&
          getPreferredLoopbackRuntimePort(environment) === deployment.localPort)
      )
    },
    {
      message:
        'A managed deployment must prefer its own tunnel and exclude independent SSH access.',
      path: ['orcadDeployment']
    }
  )

export type KnownRuntimeEnvironment = z.infer<typeof KnownRuntimeEnvironmentSchema>

export type PublicKnownRuntimeEnvironment = Omit<KnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: PublicRuntimeAccessEndpoint[]
  /** Digest of the host's persisted E2EE public key, which its pairing handshake proves. */
  hostKeyFingerprint?: string
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

// Why version 1 and the persisted schema: shipped builds accept only this shape, so every
// T5 field lives in the sidecar and a downgrade rewrite cannot lose or reject it.
export const RuntimeEnvironmentStoreSchema = z.object({
  version: z.literal(1),
  environments: z.array(PersistedRuntimeEnvironmentSchema)
})

export type RuntimeEnvironmentStore = z.infer<typeof RuntimeEnvironmentStoreSchema>

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

export function getPreferredPairingOffer(environment: KnownRuntimeEnvironment): PairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error(`Environment ${environment.name} has no access endpoints`)
  }
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
  }
}

/** The tunnel a server is reached through; only orcadDeployment also grants lifecycle ownership. */
export function getRuntimeSshAccess(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'>
): RuntimeSshTunnelLink | undefined {
  return environment.orcadDeployment ?? environment.sshAccess
}

export function getPreferredLoopbackRuntimePort(environment: {
  endpoints: { id: string; endpoint: string }[]
  preferredEndpointId: string
}): number | null {
  const endpoint = environment.endpoints.find(
    (entry) => entry.id === environment.preferredEndpointId
  )
  if (!endpoint) {
    return null
  }
  try {
    const url = new URL(endpoint.endpoint)
    const port = Number(url.port)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      classifyRemotePairingHostname(url.hostname) === 'loopback' &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535
      ? port
      : null
  } catch {
    return null
  }
}
