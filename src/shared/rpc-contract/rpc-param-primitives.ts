import { z } from 'zod'

// Why: the original handlers treated non-numeric/NaN limit values as "no
// limit" rather than as errors. Preserve that forgiving behavior so CLI
// callers passing stringified numbers or Infinity still reach the runtime.
// The outer optional() is required for omitted keys in Zod v4; an optional
// schema hidden behind pipe() still makes z.object require the property.
export const OptionalFiniteNumber = z
  .unknown()
  .transform((value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined))
  .pipe(z.union([z.number(), z.undefined()]))
  .optional()

export const OptionalPositiveInt = z
  .unknown()
  .transform((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  )
  .pipe(z.union([z.number(), z.undefined()]))
  .optional()

export const OptionalString = z
  .unknown()
  .transform((value) => (typeof value === 'string' && value.length > 0 ? value : undefined))
  .pipe(z.union([z.string(), z.undefined()]))
  .optional()

export const OptionalPlainString = z
  .unknown()
  .transform((value) => (typeof value === 'string' ? value : undefined))
  .pipe(z.union([z.string(), z.undefined()]))
  .optional()

export const OptionalBoolean = z
  .unknown()
  .transform((value) => (typeof value === 'boolean' ? value : undefined))
  .pipe(z.union([z.boolean(), z.undefined()]))
  .optional()

// Why: runtime handlers accept `linkedIssue: number | null | undefined` with
// distinct meanings — undefined means "no update", null means "clear", number
// means "set". The ambient JSON decode produces all three shapes as-is.
export const TriStateLinkedIssue = z
  .unknown()
  .transform((value) => {
    if (value === null) {
      return null
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    return undefined
  })
  .pipe(z.union([z.number(), z.null(), z.undefined()]))
  .optional()

// Why: the legacy extractBrowserTarget treated worktree as a plain-string
// passthrough (empty string preserved) but `page` as non-empty-string. The
// browser bridge uses worktree-as-empty-string to mean "any worktree", so
// keep that asymmetry intact to avoid widening scope unexpectedly.
export const BrowserTarget = z.object({
  worktree: OptionalPlainString,
  page: OptionalString
})

export function requiredString(message: string) {
  return z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, message))
}

export function requiredStringAllowingEmpty(message: string) {
  return z.unknown().refine((value): value is string => typeof value === 'string', { message })
}

export function requiredNumber(message: string) {
  return z
    .unknown()
    .transform((value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
    )
    .pipe(z.number().refine((v) => Number.isFinite(v), { message }))
}

// ─── Retained-payload range reads ──────────────────────────────────────────
// Every payload-read method (`agentSession.readPayload`,
// `orchestration.workerPayloadRead`, `orchestration.federationReadPayload`)
// reaches the same range reader, whose contract is a non-negative integer
// offset and a positive integer limit. The forgiving `OptionalFiniteNumber`
// would let zero, a negative, or a fraction through to it, so these reject at
// the boundary instead.

/** Largest chunk one payload-read reply carries; callers page with `offset`. */
export const PAYLOAD_READ_MAX_LIMIT = 256 * 1024

export const PayloadDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Payload digest must be a lowercase sha256 hex digest')

export const PayloadReadOffset = z.number().int().nonnegative().optional()

export const PayloadReadLimit = z.number().int().positive().max(PAYLOAD_READ_MAX_LIMIT).optional()
