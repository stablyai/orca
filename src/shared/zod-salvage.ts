/* Why: persisted state is machine-written, so one corrupt entry must cost that
 * entry and nothing else. These combinators declare that tolerance where the
 * data is described instead of reconstructing it from validator issue paths
 * afterwards. Zod hands transforms no path, so they track it themselves and
 * publish every drop to the collector the running parse installed. */
import { z } from 'zod'

let dropCollector: string[] | null = null
const dropPath: (string | number)[] = []

/** Run `parse`, collecting the path of every entry these combinators dropped.
 *  Not reentrant — safe because parsing is synchronous. */
export function collectSalvageDrops<T>(parse: () => T): { value: T; droppedPaths: string[] } {
  const droppedPaths: string[] = []
  dropCollector = droppedPaths
  dropPath.length = 0
  try {
    return { value: parse(), droppedPaths }
  } finally {
    dropCollector = null
    dropPath.length = 0
  }
}

function reportDrop(segment: string | number): void {
  dropCollector?.push([...dropPath, segment].join('.'))
}

function inEntry<T>(segment: string | number, parse: () => T): T {
  dropPath.push(segment)
  try {
    return parse()
  } finally {
    dropPath.pop()
  }
}

/** Array that drops the elements it cannot parse instead of failing. */
export function salvagingArray<T extends z.ZodType>(item: T): z.ZodType<z.output<T>[], unknown> {
  return z.array(z.unknown()).transform((values) =>
    values.flatMap((value, index) => {
      const parsed = inEntry(index, () => item.safeParse(value))
      if (parsed.success) {
        return [parsed.data as z.output<T>]
      }
      reportDrop(index)
      return []
    })
  )
}

/** Record that drops the entries it cannot parse — bad key or bad value — instead
 *  of failing. */
export function salvagingRecord<K extends z.ZodType<string>, V extends z.ZodType>(
  key: K,
  value: V
): z.ZodType<Record<string, z.output<V>>, unknown> {
  return z.record(z.string(), z.unknown()).transform((entries) => {
    // Why: null prototype so a persisted '__proto__' key cannot poison the result.
    const kept: Record<string, z.output<V>> = Object.create(null)
    for (const [entryKey, entryValue] of Object.entries(entries)) {
      const parsed = key.safeParse(entryKey).success
        ? inEntry(entryKey, () => value.safeParse(entryValue))
        : null
      if (parsed?.success) {
        kept[entryKey] = parsed.data as z.output<V>
        continue
      }
      reportDrop(entryKey)
    }
    return { ...kept }
  })
}

function salvaged(name: string, schema: z.ZodType, fallback: () => unknown): z.ZodType {
  return z.unknown().transform((raw, ctx) => {
    if (raw === undefined) {
      ctx.addIssue({ code: 'custom', message: 'required', input: raw })
      return z.NEVER
    }
    const parsed = inEntry(name, () => schema.safeParse(raw))
    if (parsed.success) {
      return parsed.data
    }
    reportDrop(name)
    return fallback()
  })
}

/** A required field that falls back to `fallback()` when its value is unusable,
 *  reported as one drop. `name` prefixes the drop paths its subtree reports.
 *  A *missing* value stays fatal so a foreign payload that simply lacks our
 *  fields cannot pose as a repaired session. */
export function salvagedField<T extends z.ZodType>(
  name: string,
  schema: T,
  fallback: () => z.output<T>
): z.ZodType<z.output<T>, unknown> {
  return salvaged(name, schema, fallback) as z.ZodType<z.output<T>, unknown>
}

/** An optional field that drops itself when its value is unusable. Absence is
 *  legitimate and is not reported. */
export function salvagedOptional<T extends z.ZodType>(
  name: string,
  schema: T
): z.ZodType<z.output<T> | undefined, unknown> {
  return salvaged(name, schema, () => undefined).optional() as z.ZodType<
    z.output<T> | undefined,
    unknown
  >
}
