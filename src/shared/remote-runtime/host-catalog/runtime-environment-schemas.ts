import { z } from 'zod'
import { classifyRemotePairingHostname } from '../pairing/remote-pairing-address'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'
import {
  OrcadWslDeploymentLinkSchema,
  type OrcadWslDeploymentLink
} from './wsl-host-deployment-link'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const RuntimeAccessEndpointSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    kind: z.literal('websocket'),
    label: z.string().min(1),
    endpoint: z.string().min(1),
    deviceToken: z.string().min(1),
    publicKeyB64: z.string().min(1)
  })
)

export const PublicRuntimeAccessEndpointSchema = lazyZodSchema(() =>
  RuntimeAccessEndpointSchema.omit({
    deviceToken: true,
    publicKeyB64: true
  })
)

export type PublicRuntimeAccessEndpoint = z.infer<typeof PublicRuntimeAccessEndpointSchema>

export const RuntimeEnvironmentSourceSchema = lazyZodSchema(() =>
  z.enum(['manual', 'ephemeral-vm'])
)
export type RuntimeEnvironmentSource = z.infer<typeof RuntimeEnvironmentSourceSchema>

export const RuntimeSshTunnelLinkSchema = lazyZodSchema(() =>
  z.object({
    sshTargetId: z.string().min(1),
    sshTargetGeneration: z.number().int().positive(),
    localPort: z.number().int().min(1).max(65_535),
    remotePort: z.number().int().min(1).max(65_535)
  })
)

export type RuntimeSshTunnelLink = z.infer<typeof RuntimeSshTunnelLinkSchema>

/** A server Orca deployed and owns over SSH; unlike sshAccess, it grants lifecycle ownership. */
export const OrcadSshDeploymentLinkSchema = lazyZodSchema(() =>
  RuntimeSshTunnelLinkSchema.extend({
    // Absent on disk: the sidecar persists SSH links without it, so older builds read them unchanged.
    kind: z.literal('ssh').optional()
  })
)
export type OrcadSshDeploymentLink = z.infer<typeof OrcadSshDeploymentLinkSchema>

/** A server Orca deployed and owns; the WSL kind is persisted only in wsl-host-deployment-store. */
export const OrcadDeploymentLinkSchema = lazyZodSchema(() =>
  z.union([OrcadSshDeploymentLinkSchema, OrcadWslDeploymentLinkSchema])
)
export type OrcadDeploymentLink = z.infer<typeof OrcadDeploymentLinkSchema>

export const RuntimeSshAccessLinkSchema = lazyZodSchema(() =>
  RuntimeSshTunnelLinkSchema.extend({
    requestId: z.string().min(1).optional(),
    targetFingerprint: z.string().min(1).optional(),
    endpointId: z.string().min(1),
    previousPreferredEndpointId: z.string().min(1)
  })
)

export const RuntimeSshAccessOperationSchema = lazyZodSchema(() =>
  RuntimeSshTunnelLinkSchema.omit({ localPort: true })
    .extend({
      requestId: z.string().min(1),
      operation: z.enum(['link', 'unlink']),
      targetFingerprint: z.string().min(1).optional()
    })
    .refine((intent) => intent.operation !== 'link' || !!intent.targetFingerprint, {
      message: 'Link intent requires a target fingerprint.'
    })
)

export type RuntimeSshAccessOperation = z.infer<typeof RuntimeSshAccessOperationSchema>

/** The fields shipped builds read and rewrite in orca-environments.json. */
export const PersistedRuntimeEnvironmentSchema = lazyZodSchema(() =>
  z.object({
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
)

export type PersistedRuntimeEnvironment = z.infer<typeof PersistedRuntimeEnvironmentSchema>

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

/** Overlay sidecar-only state; never persist these fields in orca-environments.json, which shipped builds strip on rewrite. */
export const KnownRuntimeEnvironmentSchema = lazyZodSchema(() =>
  PersistedRuntimeEnvironmentSchema.extend({
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
)

export type KnownRuntimeEnvironment = z.infer<typeof KnownRuntimeEnvironmentSchema>

// Retain version 1/persisted shape; newer state lives in the downgrade-safe sidecar.
export const RuntimeEnvironmentStoreSchema = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    environments: z.array(PersistedRuntimeEnvironmentSchema)
  })
)

export type RuntimeEnvironmentStore = z.infer<typeof RuntimeEnvironmentStoreSchema>
export type { OrcadWslDeploymentLink }
