import type { z } from 'zod'

/**
 * `UiUpdate` rides App.tsx's debounced writer, so one drifted enum member used
 * to fail the WHOLE batch and silently drop sidebar widths, filters and agent
 * acks alongside it. Degrade instead: a value the schema cannot express is
 * dropped from the payload and the rest of the batch still lands. Unknown KEYS
 * stay a hard rejection — the parity assertions exist to catch those.
 */
// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `z.ZodRawShape` is zod's own exported type name.
export function tolerateUnknownValues<TFields extends z.ZodRawShape>(fields: TFields): TFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [
      key,
      (schema as z.ZodType).catch(() => undefined)
    ])
  ) as unknown as TFields
}

/** Drops the `undefined` entries `tolerateUnknownValues` leaves behind, so a
 *  rejected value reads as absent rather than as an explicit clear. */
export function omitUndefinedValues<TValue extends Record<string, unknown>>(value: TValue): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as TValue
}
