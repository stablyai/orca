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
export const RuntimeSshAccessLinkSchema = RuntimeSshTunnelLinkSchema.extend({
  requestId: z.string().min(1).optional(),
  targetFingerprint: z.string().min(1).optional(),
  endpointId: z.string().min(1),
  previousPreferredEndpointId: z.string().min(1)
})
export type RuntimeSshAccessLink = z.infer<typeof RuntimeSshAccessLinkSchema>
export const OrcadDeploymentLinkSchema = RuntimeSshTunnelLinkSchema
export type OrcadDeploymentLink = RuntimeSshTunnelLink
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

export const KnownRuntimeEnvironmentSchema = z
  .object({
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
    orcadDeployment: OrcadDeploymentLinkSchema.optional(),
    sshAccess: RuntimeSshAccessLinkSchema.optional(),
    pendingSshAccessOperation: RuntimeSshAccessOperationSchema.optional(),
    reconciliation: RuntimeEnvironmentReconciliationRecordSchema.optional(),
    endpoints: z.array(RuntimeAccessEndpointSchema).min(1),
    preferredEndpointId: z.string().min(1)
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
    ({ orcadDeployment, sshAccess }) =>
      !orcadDeployment || !sshAccess || sameRuntimeSshAccess(orcadDeployment, sshAccess),
    {
      message: 'Runtime SSH access conflicts with its managed deployment link.',
      path: ['sshAccess']
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

export const RuntimeEnvironmentStoreSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  environments: z.array(KnownRuntimeEnvironmentSchema)
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
  orcadDeployment?: OrcadDeploymentLink
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
    ...(args.orcadDeployment ? { orcadDeployment: args.orcadDeployment } : {}),
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

export function isManagedOrcadRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'orcadDeployment'>
): boolean {
  return environment.orcadDeployment !== undefined
}

/** SSH is an access path; only orcadDeployment grants managed lifecycle ownership. */
export function getRuntimeSshAccess(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'>
): RuntimeSshTunnelLink | undefined {
  const { orcadDeployment, sshAccess } = environment
  if (orcadDeployment && sshAccess && !sameRuntimeSshAccess(orcadDeployment, sshAccess)) {
    throw new Error('Runtime SSH access conflicts with its managed deployment link.')
  }
  return orcadDeployment ?? sshAccess
}

function sameRuntimeSshAccess(left: RuntimeSshTunnelLink, right: RuntimeSshTunnelLink): boolean {
  return (
    left.sshTargetId === right.sshTargetId &&
    left.sshTargetGeneration === right.sshTargetGeneration &&
    left.localPort === right.localPort &&
    left.remotePort === right.remotePort
  )
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
