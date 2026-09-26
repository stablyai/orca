import { z } from 'zod'

export const PROFILE_STATE_RECOVERY_FLAG = '--profile-state-recovery'
export const PROFILE_STATE_RECOVERY_RESULT_PREFIX = '[profile-state-recovery] '

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const selectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), revision: positiveInteger }).strict(),
  z.object({ kind: z.literal('current-json') }).strict(),
  z.object({ kind: z.literal('latest-json') }).strict(),
  z.object({ kind: z.literal('sqlite'), backupId: z.string().min(1) }).strict()
])

export const profileStateRecoveryRequestSchema = z
  .object({
    userDataPath: z.string().min(1),
    selector: selectorSchema
  })
  .strict()

const exportsSchema = z.object({
  profileId: z.string(),
  dataFile: z.string(),
  databaseFile: z.string(),
  exportPaths: z.array(z.string()).readonly(),
  backups: z
    .array(z.object({ id: z.string(), path: z.string(), createdAtMs: positiveInteger }))
    .readonly()
})
const rollbackSchema = exportsSchema.extend({
  // Canonical JSON edited outside SQLite has no database revision.
  revision: positiveInteger.nullable(),
  quarantineDirectory: z.string(),
  removedDatabaseFiles: z.array(z.string()).readonly(),
  storage: z.enum(['json', 'sqlite']),
  restoredPath: z.string(),
  backupId: z.string().optional()
})

export const profileStateRecoveryResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: rollbackSchema }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid_argument', 'runtime_error']),
    message: z.string()
  })
])

export type ProfileStateRecoverySelector = z.infer<typeof selectorSchema>
export type ProfileStateRecoveryRequest = z.infer<typeof profileStateRecoveryRequestSchema>
export type ProfileStateRecoveryResponse = z.infer<typeof profileStateRecoveryResponseSchema>
export type ProfileStateExportsResult = z.infer<typeof exportsSchema>
export type ProfileStateRollbackResult = z.infer<typeof rollbackSchema>

export class ProfileStateRecoveryCommandError extends Error {
  constructor(
    readonly code: 'invalid_argument' | 'runtime_error',
    message: string
  ) {
    super(message)
    this.name = 'ProfileStateRecoveryCommandError'
  }
}

export function isProfileStateRecoveryCommandError(
  error: unknown
): error is Error & { code: 'invalid_argument' | 'runtime_error' } {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'invalid_argument' || error.code === 'runtime_error')
  )
}
