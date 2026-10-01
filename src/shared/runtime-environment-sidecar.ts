import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'
import {
  KnownRuntimeEnvironmentSchema,
  RuntimeAccessEndpointSchema,
  RuntimeSshAccessLinkSchema,
  RuntimeSshAccessOperationSchema,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'

// Why a sidecar: shipped builds parse orca-environments.json with key-stripping schemas and rewrite
// it on routine use, so T5 state stored there would vanish across a downgrade. They never touch this.
const SIDECAR_FILE = 'orca-environment-sidecar.json'
const MAX_SIDECAR_FILE_BYTES = 1024 * 1024

const SidecarBindingSchema = z.object({
  createdAt: z.number().finite(),
  pairingRevision: z.number().finite(),
  preferredEndpointId: z.string().min(1)
})

const SidecarSshAccessSchema = RuntimeSshAccessLinkSchema.extend({
  endpoint: RuntimeAccessEndpointSchema
})

const SidecarEntrySchema = z.object({
  binding: SidecarBindingSchema,
  // The runtime a link verified; it outlives the link like a learned runtimeId would.
  runtimeId: z.string().min(1).optional(),
  sshAccess: SidecarSshAccessSchema.optional(),
  pendingSshAccessOperation: RuntimeSshAccessOperationSchema.optional(),
  // Keeps the overlaid pairing revision monotonic after the access that raised it is removed.
  pairingRevisionFloor: z.number().finite().optional(),
  reconciliation: RuntimeEnvironmentReconciliationRecordSchema.optional()
})

const SidecarSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().min(1), SidecarEntrySchema)
})

export type RuntimeEnvironmentSidecarEntry = z.infer<typeof SidecarEntrySchema>
export type RuntimeEnvironmentSidecarSshAccess = z.infer<typeof SidecarSshAccessSchema>
type RuntimeEnvironmentSidecar = z.infer<typeof SidecarSchema>

export class RuntimeEnvironmentSidecarInvalidError extends Error {
  constructor(path: string) {
    super(`Could not read Orca environment links at ${path}; the file is invalid.`)
    this.name = 'RuntimeEnvironmentSidecarInvalidError'
  }
}

export function getRuntimeEnvironmentSidecarPath(userDataPath: string): string {
  return join(userDataPath, SIDECAR_FILE)
}

/** The persisted state a sidecar entry was written against; any change makes the entry stale. */
export function runtimeEnvironmentSidecarBinding(environment: PersistedRuntimeEnvironment) {
  return {
    createdAt: environment.createdAt,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    preferredEndpointId: environment.preferredEndpointId
  }
}

export function readRuntimeEnvironmentSidecar(userDataPath: string): RuntimeEnvironmentSidecar {
  const path = getRuntimeEnvironmentSidecarPath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, entries: {} }
  }
  try {
    hardenExistingSecureFile(path)
    return SidecarSchema.parse(
      JSON.parse(readNodeFileSyncWithinLimit(path, MAX_SIDECAR_FILE_BYTES).buffer.toString('utf8'))
    )
  } catch {
    throw new RuntimeEnvironmentSidecarInvalidError(path)
  }
}

function isCurrentEntry(
  environment: PersistedRuntimeEnvironment,
  entry: RuntimeEnvironmentSidecarEntry
): boolean {
  const binding = runtimeEnvironmentSidecarBinding(environment)
  return (
    entry.binding.createdAt === binding.createdAt &&
    entry.binding.pairingRevision === binding.pairingRevision &&
    entry.binding.preferredEndpointId === binding.preferredEndpointId
  )
}

/**
 * The environment callers see. An entry bound to a different pairing, or one whose overlay would be
 * inconsistent, is stale and ignored rather than trusted.
 */
export function overlayRuntimeEnvironmentSidecar(
  environment: PersistedRuntimeEnvironment,
  entry: RuntimeEnvironmentSidecarEntry | undefined
): KnownRuntimeEnvironment {
  const base = KnownRuntimeEnvironmentSchema.parse(environment)
  if (!entry || !isCurrentEntry(environment, entry)) {
    return base
  }
  const basePairingRevision = environment.pairingRevision ?? environment.createdAt
  const access = entry.sshAccess
  if (
    entry.runtimeId !== undefined &&
    environment.runtimeId !== null &&
    environment.runtimeId !== entry.runtimeId
  ) {
    return base
  }
  const pairingRevision = Math.max(
    basePairingRevision,
    entry.pairingRevisionFloor ?? basePairingRevision
  )
  const { endpoint, ...link } = access ?? {}
  const overlaid = KnownRuntimeEnvironmentSchema.safeParse({
    ...environment,
    ...(pairingRevision !== basePairingRevision ? { pairingRevision } : {}),
    ...(entry.runtimeId !== undefined
      ? { runtimeId: environment.runtimeId ?? entry.runtimeId }
      : {}),
    ...(access && endpoint
      ? {
          connectionDependency: 'ssh-tunnel',
          sshAccess: link,
          endpoints: [...environment.endpoints.filter((e) => e.id !== endpoint.id), endpoint],
          preferredEndpointId: endpoint.id
        }
      : {}),
    ...(entry.pendingSshAccessOperation
      ? { pendingSshAccessOperation: entry.pendingSshAccessOperation }
      : {}),
    ...(entry.reconciliation ? { reconciliation: entry.reconciliation } : {})
  })
  return overlaid.success ? overlaid.data : base
}

/** Replaces one environment's sidecar entry and drops entries whose environment no longer exists. */
export function writeRuntimeEnvironmentSidecarEntry(
  userDataPath: string,
  environments: readonly PersistedRuntimeEnvironment[],
  environment: PersistedRuntimeEnvironment,
  entry: Omit<RuntimeEnvironmentSidecarEntry, 'binding'> | null
): void {
  const current = readRuntimeEnvironmentSidecar(userDataPath)
  const live = new Map(environments.map((candidate) => [candidate.id, candidate]))
  const entries: Record<string, RuntimeEnvironmentSidecarEntry> = {}
  for (const [id, existing] of Object.entries(current.entries)) {
    const owner = live.get(id)
    if (id !== environment.id && owner && isCurrentEntry(owner, existing)) {
      entries[id] = existing
    }
  }
  const basePairingRevision = environment.pairingRevision ?? environment.createdAt
  const hasState =
    entry !== null &&
    ((entry.runtimeId !== undefined && environment.runtimeId === null) ||
      entry.sshAccess !== undefined ||
      entry.pendingSshAccessOperation !== undefined ||
      entry.reconciliation !== undefined ||
      (entry.pairingRevisionFloor ?? basePairingRevision) > basePairingRevision)
  if (entry && hasState) {
    entries[environment.id] = SidecarEntrySchema.parse({
      ...entry,
      binding: runtimeEnvironmentSidecarBinding(environment)
    })
  }
  writeSecureJsonFileWithinLimit(
    getRuntimeEnvironmentSidecarPath(userDataPath),
    SidecarSchema.parse({ version: 1, entries }),
    MAX_SIDECAR_FILE_BYTES,
    { durable: true }
  )
}

/** The current sidecar entry for an environment, or none when absent or stale. */
export function readCurrentRuntimeEnvironmentSidecarEntry(
  userDataPath: string,
  environment: PersistedRuntimeEnvironment
): RuntimeEnvironmentSidecarEntry | undefined {
  const entry = readRuntimeEnvironmentSidecar(userDataPath).entries[environment.id]
  return entry && isCurrentEntry(environment, entry) ? entry : undefined
}
