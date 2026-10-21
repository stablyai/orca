import { z } from 'zod'
import type {
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord,
  MachineState
} from '../../../../shared/machine-inventory'
import type {
  MachineProviderCapabilities,
  MachineProviderErrorCode
} from '../../../../shared/machine-provider-protocol'

// Why tolerant: a paired server updates on its own schedule, and this build can't be fixed after
// release. Unknown values fall back, an unreadable row is dropped, and only a reply that isn't a
// list of inventories at all is rejected.

const MACHINE_STATES: readonly MachineState[] = [
  'creating',
  'running',
  'stopping',
  'sleeping',
  'waking',
  'archived',
  'error',
  'unknown',
  'unreachable',
  'gone'
]
const ERROR_CODES: readonly MachineProviderErrorCode[] = [
  'not-found',
  'conflict',
  'auth-required',
  'unsupported',
  'unavailable',
  'quota',
  'invalid-response',
  'context-mismatch',
  'protocol-unsupported',
  'timeout',
  'cancelled'
]
const VERBS = ['create', 'sleep', 'wake', 'archive', 'delete', 'get'] as const
const LIFETIMES = ['persistent', 'temporary'] as const

const optionalText = z.string().optional().catch(undefined)

function knownOnly<const T extends readonly string[]>(values: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      values.filter((value): value is T[number] & string => list.includes(value))
    )
}

const providerKeySchema = z.custom<MachineProviderKey>(
  (value) => typeof value === 'string' && /^plugin:.+\/[^/]+$/.test(value)
)

const machineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    providerKey: providerKeySchema,
    lifetime: z.enum(LIFETIMES).catch('persistent'),
    state: z
      .string()
      .catch('unknown')
      .transform(
        (state): MachineState => MACHINE_STATES.find((known) => known === state) ?? 'unknown'
      ),
    createdAt: z.string().catch(''),
    expiresAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)))
      .optional()
      .catch(undefined),
    image: optionalText,
    creatingOperationId: optionalText,
    detail: optionalText,
    costHint: optionalText,
    lastSeenAt: z.number().catch(0),
    lastError: optionalText,
    sshTargetId: optionalText,
    runtimeEnvironmentId: optionalText,
    managedEnvironmentId: optionalText
  })
  // Why no `access`: a paired server's access names hosts only it can reach; this app never dials it.
  .transform((machine): MachineRecord => machine)

const rowsSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) =>
    rows.flatMap((row) => {
      const parsed = machineSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  )

const capabilitiesSchema = z
  .object({
    verbs: knownOnly(VERBS),
    lifetimes: knownOnly(LIFETIMES),
    maxTtlSeconds: z.number().optional().catch(undefined),
    defaultTtlSeconds: z.number().optional().catch(undefined),
    contextId: optionalText,
    contextLabel: optionalText
  })
  .transform((capabilities): MachineProviderCapabilities => capabilities)

const snapshotSchema = z.object({
  providerKey: providerKeySchema,
  name: z.string(),
  contextId: optionalText,
  clockOffsetMs: z.number().optional().catch(undefined),
  capabilities: capabilitiesSchema.optional().catch(undefined),
  listedAt: z.number().optional().catch(undefined),
  lastFailure: z
    .object({
      code: z
        .string()
        .transform(
          (code): MachineProviderErrorCode =>
            ERROR_CODES.find((known) => known === code) ?? 'unavailable'
        ),
      message: z.string(),
      at: z.number().catch(0)
    })
    .optional()
    .catch(undefined),
  machines: rowsSchema,
  pendingCreates: z
    .array(
      z.object({
        operationId: z.string(),
        startedAt: z.number().catch(0),
        name: z.string(),
        lifetime: z.enum(LIFETIMES).catch('persistent')
      })
    )
    .catch([])
})

/** A paired server's `machines.list` value, or null when it isn't one; bad rows are dropped. */
export function parseRemoteMachineSnapshots(value: unknown): MachineProviderSnapshot[] | null {
  const list = z.array(z.unknown()).safeParse(value)
  if (!list.success) {
    return null
  }
  return list.data.flatMap((entry): MachineProviderSnapshot[] => {
    const parsed = snapshotSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** A machine record a paired server returned from an action, or null when it isn't one. */
export function parseRemoteMachineRecord(value: unknown): MachineRecord | null {
  const parsed = machineSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
