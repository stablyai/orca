import type { z } from 'zod'

/** Drop unknown values so one drifted enum cannot discard App.tsx’s entire debounced settings batch.
 * Unknown keys still reject; parity checks catch missing declarations. */
export function tolerateUnknownValues<TFields extends Readonly<Record<string, z.ZodType>>>(
  fields: TFields
): TFields {
  const tolerant: Record<string, z.ZodType> = {}
  for (const [key, schema] of Object.entries(fields)) {
    tolerant[key] = schema.catch(() => undefined)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loop copies every key of `fields` and only wraps its schema in `.catch()`, so the result carries exactly `TFields`' keys; Object.entries erases that key identity.
  return tolerant as TFields
}

/** Drop rejected values as absent; undefined must not become an explicit clear. */
export function omitUndefinedValues<TValue extends Record<string, unknown>>(value: TValue): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as TValue
}
