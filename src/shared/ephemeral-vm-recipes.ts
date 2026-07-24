import { z } from 'zod'
import { parsePairingCode } from './pairing'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from './ssh-types'
// Why: ephemeral-vm-recipe-doctor imports Node's fs/path, so it must NOT be
// re-exported through this barrel — the renderer/web-client imports this module
// and would otherwise pull Node built-ins into the browser bundle (build fails).
// Node callers import doctorEphemeralVmRecipe directly from the doctor module.
export {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  redactEphemeralVmRecipeResultForDiagnostics
} from './ephemeral-vm-recipe-diagnostics'
export type { EphemeralVmRecipeResultWarning } from './ephemeral-vm-recipe-diagnostics'

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

const SavedPortForwardSchema = z
  .object({
    localPort: z.number().int().min(1).max(65535),
    remoteHost: z.string().min(1),
    remotePort: z.number().int().min(1).max(65535),
    label: z.string().min(1).optional()
  })
  .strict()

export const EphemeralVmRecipeSshTargetSchema = z
  .object({
    label: z.string().min(1),
    configHost: z.string().min(1).optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string(),
    identityFile: z.string().min(1).optional(),
    identityAgent: z.string().min(1).optional(),
    identitiesOnly: z.boolean().optional(),
    proxyCommand: z.string().min(1).optional(),
    jumpHost: z.string().min(1).optional(),
    relayGracePeriodSeconds: z
      .number()
      .int()
      .refine(
        (value) =>
          value === 0 ||
          (value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
            value <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS),
        `Relay grace period must be 0 or between ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS} and ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds.`
      )
      .optional(),
    portForwards: z.array(SavedPortForwardSchema).optional()
  })
  .strict()

export type EphemeralVmRecipeSshTarget = z.infer<typeof EphemeralVmRecipeSshTargetSchema>

const EphemeralVmRecipeOrcaServerConnectionSchema = z
  .object({
    type: z.literal('orca-server'),
    pairingCode: z.string().min(1),
    projectRoot: z.string().min(1)
  })
  .strict()

const EphemeralVmRecipeSshConnectionSchema = z
  .object({
    type: z.literal('ssh'),
    target: EphemeralVmRecipeSshTargetSchema,
    projectRoot: z.string().min(1)
  })
  .strict()

export const EphemeralVmRecipeConnectionSchema = z.discriminatedUnion('type', [
  EphemeralVmRecipeOrcaServerConnectionSchema,
  EphemeralVmRecipeSshConnectionSchema
])

export type EphemeralVmRecipeConnection = z.infer<typeof EphemeralVmRecipeConnectionSchema>

export const EphemeralVmRecipeLegacyResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    pairingCode: z.string().min(1),
    projectRoot: z.string().min(1),
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeConnectionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    connection: EphemeralVmRecipeConnectionSchema,
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export const EphemeralVmRecipeResultSchema = z.union([
  EphemeralVmRecipeLegacyResultSchema,
  EphemeralVmRecipeConnectionResultSchema
])

export type EphemeralVmRecipeLegacyResult = z.infer<typeof EphemeralVmRecipeLegacyResultSchema>
export type EphemeralVmRecipeConnectionResult = z.infer<
  typeof EphemeralVmRecipeConnectionResultSchema
>
export type EphemeralVmRecipeResult = z.infer<typeof EphemeralVmRecipeResultSchema>

export type EphemeralVmRecipeResultParseResult =
  | { ok: true; result: EphemeralVmRecipeResult }
  | { ok: false; error: string }

export type EphemeralVmRecipeDoctorCheckStatus = 'pass' | 'warn' | 'fail'

export type EphemeralVmRecipeDoctorCheck = {
  id: string
  status: EphemeralVmRecipeDoctorCheckStatus
  message: string
  remediation?: string
}

export type EphemeralVmRecipeDoctorResult = {
  recipeId: string
  repoPath: string
  ok: boolean
  checks: EphemeralVmRecipeDoctorCheck[]
}

export function parseEphemeralVmRecipeResult(stdout: string): EphemeralVmRecipeResultParseResult {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { ok: false, error: 'Recipe produced no JSON result.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'Recipe stdout must be one JSON object.' }
  }
  const result = EphemeralVmRecipeResultSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid recipe result.' }
  }
  const connection = getEphemeralVmRecipeResultConnection(result.data)
  if (connection.type === 'orca-server' && !parsePairingCode(connection.pairingCode)) {
    return { ok: false, error: 'Recipe result pairingCode is not a valid Orca pairing code.' }
  }
  if (!isAbsoluteRuntimePath(connection.projectRoot)) {
    return { ok: false, error: 'Recipe result projectRoot must be an absolute runtime path.' }
  }
  return { ok: true, result: result.data }
}

export function getEphemeralVmRecipeResultConnection(
  result: EphemeralVmRecipeResult
): EphemeralVmRecipeConnection {
  if ('connection' in result) {
    return result.connection
  }
  return {
    type: 'orca-server',
    pairingCode: result.pairingCode,
    projectRoot: result.projectRoot
  }
}

export function getEphemeralVmRecipeResultProjectRoot(result: EphemeralVmRecipeResult): string {
  return getEphemeralVmRecipeResultConnection(result).projectRoot
}

export function getEphemeralVmRecipeResultPairingCode(
  result: EphemeralVmRecipeResult
): string | null {
  const connection = getEphemeralVmRecipeResultConnection(result)
  return connection.type === 'orca-server' ? connection.pairingCode : null
}

export function getEphemeralVmRecipeResultUserData(
  result: EphemeralVmRecipeResult
): Record<string, JsonValue> | undefined {
  return result.userData
}

export function getDefaultSshRelayGracePeriodSeconds(): number {
  return DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
}

export function isAbsoluteRuntimePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
}
