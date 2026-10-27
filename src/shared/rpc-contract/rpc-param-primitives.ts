import { z } from 'zod'

// Preserve legacy nonnumeric/nonfinite limits as absent. Zod v4 needs outer optional(): one hidden by pipe
// still makes object keys required.
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

// Preserve three update meanings: undefined leaves unchanged, null clears, number sets.
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

// Legacy browser targeting permits empty worktree (“any worktree”) but requires a nonempty page; preserve that asymmetry.
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
