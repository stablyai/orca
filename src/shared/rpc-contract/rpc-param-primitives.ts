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

// Why: an emptied text field must clear, not vanish. `OptionalString` folds `''` into
// `undefined` ("no update"), which turns a clear into a silent no-op on any handler guarding on
// `!== undefined` — while an Electron IPC schema that passes `''` through clears. Blank means
// null here, so both hops agree on what an emptied field did.
//
// Why this one rejects a wrong-typed value where `OptionalString` absorbs it: for a field whose
// point is telling "set", "clear" and "no update" apart, a silently-absorbed fourth state lets a
// client with a type bug read a success response carrying the old value. An ABSENT field still
// means "no update", so an older peer that never heard of the field stays tolerated.
export const ClearableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (typeof value === 'string' && value.trim().length === 0 ? null : value))

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
