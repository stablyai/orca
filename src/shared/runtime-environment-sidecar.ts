import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'
import { readEnvironmentStoreRecords } from './runtime-environment-store-records'
import {
  getPreferredLoopbackRuntimePort,
  KnownRuntimeEnvironmentSchema,
  RuntimeAccessEndpointSchema,
  RuntimeSshAccessLinkSchema,
  RuntimeSshAccessOperationSchema,
  RuntimeSshTunnelLinkSchema,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'

// Shipped builds strip unknown environment fields on routine writes; preserve newer state in this untouched sidecar.
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
  // The store state a two-file rebind is moving to; the entry stays current through a crash between them.
  pendingBinding: SidecarBindingSchema.optional(),
  // A verified link’s runtime ID until stored; differing IDs mean restart because orcad mints one each start (#32957).
  runtimeId: z.string().min(1).optional(),
  sshAccess: SidecarSshAccessSchema.optional(),
  pendingSshAccessOperation: RuntimeSshAccessOperationSchema.optional(),
  // The managed SSH deployment's tunnel, without a `kind` so older builds read it unchanged.
  // WSL deployments live in wsl-host-deployment-store instead.
  orcadDeployment: RuntimeSshTunnelLinkSchema.optional(),
  // A rollback to a snapshot older than this would discard the migrated catalog.
  orcadMigratedAt: z.string().datetime().optional(),
  // Keeps the overlaid pairing revision monotonic after the access that raised it is removed.
  pairingRevisionFloor: z.number().finite().optional(),
  reconciliation: RuntimeEnvironmentReconciliationRecordSchema.optional()
})

const SidecarSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().min(1), SidecarEntrySchema)
})

// Entries stay opaque so one bad or newer-format entry cannot hide every server.
const SidecarEnvelopeSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.unknown())
})

export type RuntimeEnvironmentSidecarEntry = z.infer<typeof SidecarEntrySchema>
type RuntimeEnvironmentSidecar = z.infer<typeof SidecarSchema> & {
  /** Entries this build cannot read, kept verbatim; their environments must not be used. */
  unreadable: Record<string, unknown>
}

export class RuntimeEnvironmentSidecarInvalidError extends Error {
  constructor(path: string, environmentId?: string) {
    super(
      environmentId === undefined
        ? `Could not read Orca environment links at ${path}; the file is invalid.`
        : `Could not read the Orca environment link for ${environmentId} at ${path}; it may need a newer version of Orca.`
    )
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
    return { version: 1, entries: {}, unreadable: {} }
  }
  let raw: Record<string, unknown>
  try {
    hardenExistingSecureFile(path)
    raw = SidecarEnvelopeSchema.parse(
      JSON.parse(readNodeFileSyncWithinLimit(path, MAX_SIDECAR_FILE_BYTES).buffer.toString('utf8'))
    ).entries
  } catch {
    throw new RuntimeEnvironmentSidecarInvalidError(path)
  }
  const entries: RuntimeEnvironmentSidecar['entries'] = {}
  const unreadable: RuntimeEnvironmentSidecar['unreadable'] = {}
  for (const [id, value] of Object.entries(raw)) {
    const entry = SidecarEntrySchema.safeParse(value)
    // defineProperty: a JSON "__proto__" key must stay data, not replace the prototype.
    Object.defineProperty(id.length > 0 && entry.success ? entries : unreadable, id, {
      value: entry.success ? entry.data : value,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return { version: 1, entries, unreadable }
}

function isCurrentEntry(
  environment: PersistedRuntimeEnvironment,
  entry: RuntimeEnvironmentSidecarEntry
): boolean {
  return currentEntry(environment, entry) !== undefined
}

/** The entry as of `environment`, or none when it is bound to a different store state. */
function currentEntry(
  environment: PersistedRuntimeEnvironment,
  entry: RuntimeEnvironmentSidecarEntry
): RuntimeEnvironmentSidecarEntry | undefined {
  const binding = runtimeEnvironmentSidecarBinding(environment)
  const matches = (candidate: z.infer<typeof SidecarBindingSchema> | undefined): boolean =>
    candidate?.createdAt === binding.createdAt &&
    candidate.pairingRevision === binding.pairingRevision &&
    candidate.preferredEndpointId === binding.preferredEndpointId
  if (matches(entry.binding)) {
    return entry
  }
  if (!matches(entry.pendingBinding)) {
    return undefined
  }
  // A rebind stopped after its store write: the stored endpoint already names the new tunnel port.
  const localPort = getPreferredLoopbackRuntimePort(environment)
  return entry.orcadDeployment && localPort !== null
    ? { ...entry, orcadDeployment: { ...entry.orcadDeployment, localPort } }
    : entry
}

/** Ignore stale sidecars whose pairing binding or overlay validation no longer matches. */
export function overlayRuntimeEnvironmentSidecar(
  environment: PersistedRuntimeEnvironment,
  entry: RuntimeEnvironmentSidecarEntry | undefined
): KnownRuntimeEnvironment {
  const base = KnownRuntimeEnvironmentSchema.parse(environment)
  const current = entry && currentEntry(environment, entry)
  if (!current) {
    return base
  }
  const basePairingRevision = environment.pairingRevision ?? environment.createdAt
  const access = current.sshAccess
  const pairingRevision = Math.max(
    basePairingRevision,
    current.pairingRevisionFloor ?? basePairingRevision
  )
  const { endpoint, ...link } = access ?? {}
  const overlaid = KnownRuntimeEnvironmentSchema.safeParse({
    ...environment,
    ...(pairingRevision !== basePairingRevision ? { pairingRevision } : {}),
    ...(current.runtimeId !== undefined
      ? { runtimeId: environment.runtimeId ?? current.runtimeId }
      : {}),
    ...(access && endpoint
      ? {
          connectionDependency: 'ssh-tunnel',
          sshAccess: link,
          endpoints: [...environment.endpoints.filter((e) => e.id !== endpoint.id), endpoint],
          preferredEndpointId: endpoint.id
        }
      : {}),
    ...(current.pendingSshAccessOperation
      ? { pendingSshAccessOperation: current.pendingSshAccessOperation }
      : {}),
    ...(current.orcadDeployment ? { orcadDeployment: current.orcadDeployment } : {}),
    ...(current.orcadMigratedAt ? { orcadMigratedAt: current.orcadMigratedAt } : {}),
    ...(current.reconciliation ? { reconciliation: current.reconciliation } : {})
  })
  return overlaid.success ? overlaid.data : base
}

/** Replace an entry/prune absent owners; pendingEnvironment binds both sides of a two-file store transition. */
export function writeRuntimeEnvironmentSidecarEntry(
  userDataPath: string,
  environments: readonly PersistedRuntimeEnvironment[],
  environment: PersistedRuntimeEnvironment,
  entry: Omit<RuntimeEnvironmentSidecarEntry, 'binding'> | null,
  pendingEnvironment?: PersistedRuntimeEnvironment
): void {
  const current = readRuntimeEnvironmentSidecar(userDataPath)
  // Never replace what we cannot read: it may hold this server's SSH pin or deployment link.
  if (Object.hasOwn(current.unreadable, environment.id)) {
    throw new RuntimeEnvironmentSidecarInvalidError(
      getRuntimeEnvironmentSidecarPath(userDataPath),
      environment.id
    )
  }
  const live = new Map(environments.map((candidate) => [candidate.id, candidate]))
  // Servers whose main record this build cannot read still own their entries.
  const foreignOwners = new Set(
    readEnvironmentStoreRecords(userDataPath, { recoverBlankStore: true }).unreadable.map(
      (record) => record.id
    )
  )
  const entries: Record<string, RuntimeEnvironmentSidecarEntry> = {}
  for (const [id, existing] of Object.entries(current.entries)) {
    const owner = live.get(id)
    if (
      id !== environment.id &&
      ((owner && isCurrentEntry(owner, existing)) || (!owner && foreignOwners.has(id)))
    ) {
      entries[id] = existing
    }
  }
  const basePairingRevision = environment.pairingRevision ?? environment.createdAt
  const hasState =
    entry !== null &&
    ((entry.runtimeId !== undefined && environment.runtimeId === null) ||
      entry.sshAccess !== undefined ||
      entry.pendingSshAccessOperation !== undefined ||
      entry.orcadDeployment !== undefined ||
      entry.orcadMigratedAt !== undefined ||
      entry.reconciliation !== undefined ||
      (entry.pairingRevisionFloor ?? basePairingRevision) > basePairingRevision)
  if (entry && hasState) {
    const { pendingBinding: _staleTarget, ...state } = entry
    entries[environment.id] = SidecarEntrySchema.parse({
      ...state,
      binding: runtimeEnvironmentSidecarBinding(environment),
      ...(pendingEnvironment
        ? { pendingBinding: runtimeEnvironmentSidecarBinding(pendingEnvironment) }
        : {})
    })
  }
  writeSecureJsonFileWithinLimit(
    getRuntimeEnvironmentSidecarPath(userDataPath),
    {
      version: 1,
      // Unreadable entries are never pruned: this build cannot tell whether they are stale.
      entries: { ...SidecarSchema.parse({ version: 1, entries }).entries, ...current.unreadable }
    },
    MAX_SIDECAR_FILE_BYTES,
    { durable: true }
  )
}

/** The current sidecar entry for an environment, or none when absent or stale. Throws when unreadable. */
export function readCurrentRuntimeEnvironmentSidecarEntry(
  userDataPath: string,
  environment: PersistedRuntimeEnvironment
): RuntimeEnvironmentSidecarEntry | undefined {
  const sidecar = readRuntimeEnvironmentSidecar(userDataPath)
  if (Object.hasOwn(sidecar.unreadable, environment.id)) {
    throw new RuntimeEnvironmentSidecarInvalidError(
      getRuntimeEnvironmentSidecarPath(userDataPath),
      environment.id
    )
  }
  const entry = sidecar.entries[environment.id]
  return entry && currentEntry(environment, entry)
}
