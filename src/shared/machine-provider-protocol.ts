import { z } from 'zod'
import { isRuntimePathAbsolute } from './cross-platform-path'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import {
  MACHINE_ID_PATTERN,
  isTargetedMachineProviderVerb,
  type MachineProviderVerb
} from './machine-provider-command'
import { parsePairingCode } from './pairing'

export const MACHINE_PROVIDER_PROTOCOL_VERSION = 1
export const MACHINE_PROVIDER_MAX_MACHINES = 256
const MACHINE_PROVIDER_JSON_LIMITS = { structuralTokens: 32 * 1024, nestingDepth: 16 } as const

const PROVIDER_ERROR_CODES = [
  'not-found',
  'conflict',
  'auth-required',
  'unsupported',
  'unavailable',
  'quota'
] as const
type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]

export type MachineProviderErrorCode =
  | ProviderErrorCode
  | 'invalid-response'
  | 'context-mismatch'
  | 'protocol-unsupported'
  // A mutation whose outcome is unknown; callers reconcile with a read, never a re-run.
  | 'timeout'
  | 'cancelled'

export class MachineProviderError extends Error {
  constructor(
    readonly code: MachineProviderErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'MachineProviderError'
  }
}

const shortText = (max: number): z.ZodString => z.string().trim().min(1).max(max)
const timestamp = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO timestamp')
// Why: these reach ssh argv and ssh_config; a leading "-" or whitespace would inject options.
const sshToken = z
  .string()
  .min(1)
  .max(255)
  .refine(
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what is rejected
    (value) => !value.startsWith('-') && !/[\s\u0000-\u001f\u007f]/.test(value),
    'must not start with "-" or contain whitespace or control characters'
  )
const projectRoot = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isRuntimePathAbsolute(value), 'must be an absolute path')
const hostKeyFingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
// "<type> <base64>"; system OpenSSH can only pin a key it can write into known_hosts.
const hostPublicKey = z
  .string()
  .max(16 * 1024)
  .regex(/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}$/)

const sshAccessSchema = z
  .object({
    kind: z.literal('ssh'),
    host: sshToken,
    port: z.number().int().min(1).max(65535),
    user: sshToken,
    projectRoot,
    configHost: sshToken.optional(),
    jumpHost: sshToken.optional(),
    hostKeyFingerprints: z.array(hostKeyFingerprint).min(1).max(16).optional(),
    hostKeys: z.array(hostPublicKey).min(1).max(16).optional()
  })
  .strict()

const orcaServerAccessSchema = z
  .object({
    kind: z.literal('orca-server'),
    pairingCode: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => parsePairingCode(value) !== null, 'must be an Orca pairing code'),
    projectRoot
  })
  .strict()

const machineAccessSchema = z.discriminatedUnion('kind', [sshAccessSchema, orcaServerAccessSchema])
export type MachineAccess = z.infer<typeof machineAccessSchema>

const MACHINE_LIFETIMES = ['persistent', 'temporary'] as const
const lifetimeSchema = z.enum(MACHINE_LIFETIMES)
export type MachineLifetime = z.infer<typeof lifetimeSchema>

const PROVIDER_MACHINE_STATES = [
  'creating',
  'running',
  // A sleep or archive the provider accepted but has not finished.
  'stopping',
  'sleeping',
  'waking',
  'archived',
  'error',
  'unknown'
] as const
// Why tolerant: a state from a newer provider reads as unknown instead of failing the whole list.
const providerMachineStateSchema = z
  .string()
  .max(64)
  .transform(
    (state): (typeof PROVIDER_MACHINE_STATES)[number] =>
      PROVIDER_MACHINE_STATES.find((known) => known === state) ?? 'unknown'
  )
export type ProviderMachineState = z.infer<typeof providerMachineStateSchema>

const providerMachineSchema = z
  .object({
    id: z.string().regex(MACHINE_ID_PATTERN),
    name: shortText(128),
    lifetime: lifetimeSchema,
    state: providerMachineStateSchema,
    createdAt: timestamp,
    /**
     * When a temporary machine is deleted. The provider owns enforcing it, ideally with the
     * platform's own TTL; Orca only shows and warns about it and never deletes on its own.
     */
    expiresAt: timestamp.optional(),
    image: shortText(256).optional(),
    creatingOperationId: shortText(128).optional(),
    access: machineAccessSchema.optional(),
    detail: shortText(256).optional(),
    costHint: shortText(64).optional()
  })
  .refine((machine) => !machine.access || machine.state === 'running', {
    message: 'access is only allowed while running',
    path: ['access']
  })
export type ProviderMachine = z.infer<typeof providerMachineSchema>

// Why filter rather than reject: a newer provider may advertise verbs or lifetimes this build ignores.
function knownValues<const T extends readonly [string, ...string[]]>(
  values: T
): z.ZodType<T[number][]> {
  const known = new Set<string>(values)
  return z
    .array(z.string().max(64))
    .max(32)
    .transform((list) =>
      list.filter(
        (value, index): value is T[number] => known.has(value) && list.indexOf(value) === index
      )
    )
}

const capabilitiesSchema = z.object({
  verbs: knownValues(['create', 'sleep', 'wake', 'archive', 'delete', 'get'] as const),
  lifetimes: knownValues(MACHINE_LIFETIMES).refine(
    (lifetimes) => lifetimes.length > 0,
    'at least one supported lifetime is required'
  ),
  maxTtlSeconds: z.number().int().positive().optional(),
  defaultTtlSeconds: z.number().int().positive().optional(),
  images: z
    .array(z.object({ id: shortText(256), label: shortText(128) }))
    .max(64)
    .optional(),
  defaultImage: shortText(256).optional(),
  contextId: shortText(256).optional(),
  contextLabel: shortText(128).optional(),
  signInCommand: z.array(z.string().min(1).max(4096)).min(1).max(32).optional()
})
export type MachineProviderCapabilities = z.infer<typeof capabilitiesSchema>

const envelope = {
  protocolVersion: z.literal(MACHINE_PROVIDER_PROTOCOL_VERSION),
  operationId: shortText(128),
  contextId: shortText(256).optional(),
  now: timestamp
}

const responseSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('capabilities'), capabilities: capabilitiesSchema }),
  z.object({
    ...envelope,
    kind: z.literal('inventory'),
    machines: z
      .array(providerMachineSchema)
      .max(MACHINE_PROVIDER_MAX_MACHINES)
      .refine(
        (machines) => new Set(machines.map((machine) => machine.id)).size === machines.length,
        'machine ids must be unique'
      )
  }),
  z.object({ ...envelope, kind: z.literal('machine'), machine: providerMachineSchema }),
  // A delete's success; an `error` with code `not-found` still means the same.
  z.object({
    ...envelope,
    kind: z.literal('deleted'),
    machineId: z.string().regex(MACHINE_ID_PATTERN)
  }),
  z.object({
    ...envelope,
    kind: z.literal('error'),
    // Why: an error code from a newer provider still surfaces as a failure, not a parse error.
    code: z
      .string()
      .max(64)
      .transform(
        (code): ProviderErrorCode =>
          PROVIDER_ERROR_CODES.find((known) => known === code) ?? 'unavailable'
      ),
    message: z.string().max(4096)
  })
])
// A `deleted` answer is read as `not-found`, so callers never see it.
export type MachineProviderResponse = Exclude<z.infer<typeof responseSchema>, { kind: 'deleted' }>
export type MachineProviderSuccess = Exclude<MachineProviderResponse, { kind: 'error' }>

export type MachineProviderRequest = {
  protocolVersion: typeof MACHINE_PROVIDER_PROTOCOL_VERSION
  operationId: string
  verb: MachineProviderVerb
  contextId?: string
  machineId?: string
  params?: Record<string, unknown>
}

const EXPECTED_KIND: Record<MachineProviderVerb, MachineProviderSuccess['kind']> = {
  capabilities: 'capabilities',
  list: 'inventory',
  get: 'machine',
  create: 'machine',
  sleep: 'machine',
  wake: 'machine',
  archive: 'machine',
  delete: 'machine'
}

function invalid(message: string): MachineProviderError {
  return new MachineProviderError('invalid-response', message)
}

/** Parses one provider stdout document and checks it answers `request`. */
export function parseMachineProviderResponse(
  stdout: string,
  request: MachineProviderRequest
): MachineProviderResponse {
  const text = stdout.trim()
  if (!text) {
    throw invalid('The provider printed no JSON response.')
  }
  let json: unknown
  try {
    assertJsonTextStructureWithinLimits(text, MACHINE_PROVIDER_JSON_LIMITS)
    json = JSON.parse(text)
  } catch {
    throw invalid('The provider response is not one bounded JSON document.')
  }
  const version =
    typeof json === 'object' && json !== null && 'protocolVersion' in json
      ? json.protocolVersion
      : undefined
  if (typeof version === 'number' && version > MACHINE_PROVIDER_PROTOCOL_VERSION) {
    throw new MachineProviderError(
      'protocol-unsupported',
      `The provider speaks protocol ${version}; this Orca needs a newer version.`
    )
  }
  const parsed = responseSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalid(
      `Invalid provider response${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'schema mismatch'}`
    )
  }
  const response = parsed.data
  if (response.operationId !== request.operationId) {
    throw invalid('The provider response does not echo the request operationId.')
  }
  // A signed-out or unreachable provider may not know its account. Any other answer, including
  // not-found, would change Orca's state, so it must come from the account Orca asked.
  const mayOmitContext =
    response.kind === 'error' &&
    (response.code === 'auth-required' || response.code === 'unavailable')
  if (
    !mayOmitContext &&
    request.contextId !== undefined &&
    response.contextId !== request.contextId
  ) {
    throw new MachineProviderError(
      'context-mismatch',
      'The provider is signed in as a different account.'
    )
  }
  if (response.kind === 'error') {
    return response
  }
  if (response.kind === 'deleted') {
    if (request.verb !== 'delete' || response.machineId !== request.machineId) {
      throw invalid(`The provider answered ${request.verb} with a deleted response.`)
    }
    // Why not-found: it is what older providers answer, and the delete path already settles on it.
    const { machineId: _deleted, ...rest } = response
    return { ...rest, kind: 'error', code: 'not-found', message: 'The machine was deleted.' }
  }
  if (response.kind !== EXPECTED_KIND[request.verb]) {
    throw invalid(`The provider answered ${request.verb} with a ${response.kind} response.`)
  }
  if (
    response.kind === 'machine' &&
    isTargetedMachineProviderVerb(request.verb) &&
    response.machine.id !== request.machineId
  ) {
    throw invalid(`The provider answered ${request.verb} for a different machine.`)
  }
  return response
}
