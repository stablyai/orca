import { z } from 'zod'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from './paired-runtime-connection'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'
import {
  OrcadWslDeploymentLinkSchema,
  type OrcadWslDeploymentLink
} from './wsl-host-deployment-link'
import type { WslHostServerStop } from './wsl-host-types'

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
export const OrcadSshDeploymentLinkSchema = RuntimeSshTunnelLinkSchema.extend({
  // Absent on disk: the sidecar persists SSH links without it, so older builds read them unchanged.
  kind: z.literal('ssh').optional()
})
export type OrcadSshDeploymentLink = z.infer<typeof OrcadSshDeploymentLinkSchema>

/** A server Orca deployed and owns; the WSL kind is persisted only in wsl-host-deployment-store. */
export const OrcadDeploymentLinkSchema = z.union([
  OrcadSshDeploymentLinkSchema,
  OrcadWslDeploymentLinkSchema
])
export type OrcadDeploymentLink = z.infer<typeof OrcadDeploymentLinkSchema>

/** The managed deployment Orca owns over SSH; undefined for none or a WSL one. */
export function getOrcadSshDeployment(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): OrcadSshDeploymentLink | undefined {
  const deployment = environment.orcadDeployment
  return deployment && deployment.kind !== 'wsl' ? deployment : undefined
}

export const RuntimeSshAccessLinkSchema = RuntimeSshTunnelLinkSchema.extend({
  requestId: z.string().min(1).optional(),
  targetFingerprint: z.string().min(1).optional(),
  endpointId: z.string().min(1),
  previousPreferredEndpointId: z.string().min(1)
})

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

/** Overlay sidecar-only state; never persist these fields in orca-environments.json, which shipped builds strip on rewrite. */
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
      // Keep WSL dependency in its own file: older environment schemas reject new connectionDependency values.
      const dependency = deployment?.kind === 'wsl' ? undefined : 'ssh-tunnel'
      return (
        !deployment ||
        (!environment.sshAccess &&
          environment.connectionDependency === dependency &&
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

// Retain version 1/persisted shape; newer state lives in the downgrade-safe sidecar.
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

function preferredEndpoint(environment: PreferredEndpointSource) {
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
