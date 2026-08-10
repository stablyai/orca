// Zod transforms lack paths, so salvage combinators track bounded diagnostics during parsing.
import { z } from 'zod'

const MAX_REPORTED_SALVAGE_PATHS = 100

type DropCollector = { paths: string[]; count: number }

let dropCollector: DropCollector | null = null
const dropPath: (string | number)[] = []

/** Run a synchronous parse while collecting its salvage count and example paths. */
export function collectSalvageDrops<T>(parse: () => T): {
  value: T
  droppedPaths: string[]
  droppedCount: number
} {
  const previousCollector = dropCollector
  const previousPath = [...dropPath]
  const collector: DropCollector = { paths: [], count: 0 }
  dropCollector = collector
  dropPath.length = 0
  try {
    const value = parse()
    return { value, droppedPaths: collector.paths, droppedCount: collector.count }
  } finally {
    dropCollector = previousCollector
    dropPath.splice(0, dropPath.length, ...previousPath)
  }
}

function reportDrop(segment: string | number): void {
  if (!dropCollector) {
    return
  }
  dropCollector.count += 1
  if (dropCollector.paths.length < MAX_REPORTED_SALVAGE_PATHS) {
    dropCollector.paths.push([...dropPath, segment].join('.'))
  }
}

function inEntry<T>(segment: string | number, parse: () => T): T {
  dropPath.push(segment)
  try {
    return parse()
  } finally {
    dropPath.pop()
  }
}

function parseEntry<T extends z.ZodType>(
  schema: T,
  raw: unknown
): { success: true; data: z.output<T> } | { success: false } {
  try {
    const parsed = schema.safeParse(raw)
    return parsed.success ? { success: true, data: parsed.data as z.output<T> } : { success: false }
  } catch {
    return { success: false }
  }
}

/** Array that drops the elements it cannot parse instead of failing. */
export function salvagingArray<T extends z.ZodType>(item: T): z.ZodType<z.output<T>[], unknown> {
  return z.array(z.unknown()).transform((values) =>
    values.flatMap((value, index) => {
      const parsed = inEntry(index, () => parseEntry(item, value))
      if (parsed.success) {
        return [parsed.data]
      }
      reportDrop(index)
      return []
    })
  )
}

/** Record that drops entries with invalid keys or values instead of failing. */
export function salvagingRecord<K extends z.ZodType<string>, V extends z.ZodType>(
  key: K,
  value: V,
  accepts?: (key: string, value: z.output<V>) => boolean
): z.ZodType<Record<string, z.output<V>>, unknown> {
  return z.record(z.string(), z.unknown()).transform((entries) => {
    // Why: null prototype so a persisted '__proto__' key cannot poison the result.
    const kept: Record<string, z.output<V>> = Object.create(null)
    for (const [entryKey, entryValue] of Object.entries(entries)) {
      const parsed = parseEntry(key, entryKey).success
        ? inEntry(entryKey, () => parseEntry(value, entryValue))
        : null
      if (parsed?.success && (!accepts || accepts(entryKey, parsed.data))) {
        kept[entryKey] = parsed.data
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
    const parsed = inEntry(name, () => parseEntry(schema, raw))
    if (parsed.success) {
      return parsed.data
    }
    reportDrop(name)
    return fallback()
  })
}

/** Fall back for an invalid required field; absence stays fatal for foreign payloads. */
export function salvagedField<T extends z.ZodType>(
  name: string,
  schema: T,
  fallback: () => z.output<T>
): z.ZodType<z.output<T>, unknown> {
  return salvaged(name, schema, fallback) as z.ZodType<z.output<T>, unknown>
}

/** Drop an invalid optional field without reporting legitimate absence. */
export function salvagedOptional<T extends z.ZodType>(
  name: string,
  schema: T
): z.ZodType<z.output<T> | undefined, unknown> {
  return salvaged(name, schema, () => undefined).optional() as z.ZodType<
    z.output<T> | undefined,
    unknown
  >
}
