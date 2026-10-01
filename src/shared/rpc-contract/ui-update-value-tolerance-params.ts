import type { z } from 'zod'

/**
 * `UiUpdate` rides App.tsx's debounced writer, so one drifted enum member used
 * to fail the WHOLE batch and silently drop sidebar widths, filters and agent
 * acks alongside it. Degrade instead: a value the schema cannot express is
 * dropped from the payload and the rest of the batch still lands. Unknown KEYS
 * stay a hard rejection — the parity assertions exist to catch those.
 */
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

/** Drops the `undefined` entries `tolerateUnknownValues` leaves behind, so a
 *  rejected value reads as absent rather than as an explicit clear. */
export function omitUndefinedValues<TValue extends Record<string, unknown>>(value: TValue): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as TValue
}
