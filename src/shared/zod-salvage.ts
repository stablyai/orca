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

/** parseEntry with `segment` on the diagnostic path. Takes the schema and value rather than a
 *  thunk: this runs once per persisted record, and a closure per entry is the dominant load cost. */
function parseEntryAt<T extends z.ZodType>(
  segment: string | number,
  schema: T,
  raw: unknown
): { success: true; data: z.output<T> } | { success: false } {
  dropPath.push(segment)
  try {
    return parseEntry(schema, raw)
  } finally {
    dropPath.pop()
  }
}

/** The keys `z.record(z.string(), z.unknown())` would hand a transform, or null where it would
 *  reject: not a plain object, or carrying an enumerable symbol key its string key schema fails.
 *  Why: every entry is re-validated below anyway, so letting zod build a throwaway copy first is a
 *  second full traversal of the largest maps in the persisted session. */
function recordEntryKeys(raw: unknown): string[] | null {
  if (!z.core.util.isPlainObject(raw)) {
    return null
  }
  for (const symbol of Object.getOwnPropertySymbols(raw)) {
    if (Object.prototype.propertyIsEnumerable.call(raw, symbol)) {
      return null
    }
  }
  return Object.keys(raw)
}

/**
 * Enum whose arm set is a wire surface: an arm this build does not know degrades to `fallback`
 * instead of rejecting the reply. A non-string stays fatal, so this widens the vocabulary without
 * also accepting the wrong type. Not `.catch()`, which would swallow absence too.
 */
// `readonly string[]` rather than a non-empty tuple so a hostUnionArms list can feed it; z.enum
// takes the same, so the tuple constraint only excluded callers zod itself accepts. `const` keeps a
// bare literal's arms, which the parsed type is built from.
export function openEnum<const T extends readonly string[], F extends T[number] | undefined>(
  values: T,
  fallback: F
): z.ZodType<T[number] | F, unknown> {
  return z.enum(values).or(z.string().transform(() => fallback))
}

/**
 * The arms of a closed enum, spelled as a coverage record over the host's own union so tsc holds
 * the schema to that union both ways: an arm the host adds is a missing property here, one it drops
 * is an excess property. `NoInfer` keeps U from being read off the record, so omitting the type
 * argument leaves it at its `never` default and the parameter becomes `never` — the call fails to
 * compile rather than pinning the record only to itself. It belongs in the schema module rather
 * than its test because the list is what feeds `z.enum`: the coverage record and the arms the
 * schema actually accepts are then one object, and a test-side copy could drift from it.
 */
export function hostUnionArms<U extends string = never>(
  coverage: [U] extends [never] ? never : Readonly<Record<NoInfer<U>, true>>
): readonly U[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapped parameter type makes every key exactly a U; Object.keys only loses that at the type level.
  return Object.keys(coverage) as U[]
}

/** Array that drops the elements it cannot parse instead of failing.
 *  Absence stays fatal on its own: both containers issue on `undefined` and, being bare transforms,
 *  set neither optin nor optout, and zod only swallows an absent key's issues when a field is both.
 *  salvagedField/salvagedOptional wrap them for fallback semantics, not for absence detection.
 *  Pinned by zod-salvage-absence.test.ts. */
export function salvagingArray<T extends z.ZodType>(item: T): z.ZodType<z.output<T>[], unknown> {
  return z.unknown().transform((raw, ctx) => {
    if (!Array.isArray(raw)) {
      ctx.addIssue({ code: 'invalid_type', expected: 'array', input: raw })
      return z.NEVER
    }
    const kept: z.output<T>[] = []
    for (let index = 0; index < raw.length; index += 1) {
      const parsed = parseEntryAt(index, item, raw[index])
      if (parsed.success) {
        kept.push(parsed.data)
        continue
      }
      reportDrop(index)
    }
    return kept
  }) as z.ZodType<z.output<T>[], unknown>
}

/** Record that drops entries with invalid keys or values instead of failing. */
export function salvagingRecord<K extends z.ZodType<string>, V extends z.ZodType>(
  key: K,
  value: V,
  accepts?: (key: string, value: z.output<V>) => boolean
): z.ZodType<Record<string, z.output<V>>, unknown> {
  return z.unknown().transform((raw, ctx) => {
    const entryKeys = recordEntryKeys(raw)
    if (!entryKeys) {
      ctx.addIssue({ code: 'invalid_type', expected: 'record', input: raw })
      return z.NEVER
    }
    const entries = raw as Record<string, unknown>
    // Why: null prototype so a persisted '__proto__' key cannot poison the result.
    const kept: Record<string, z.output<V>> = Object.create(null)
    for (const entryKey of entryKeys) {
      // Why: z.record strips '__proto__' before the value schema sees it, so it is not a drop.
      if (entryKey === '__proto__') {
        continue
      }
      const parsed = parseEntry(key, entryKey).success
        ? parseEntryAt(entryKey, value, entries[entryKey])
        : null
      if (parsed?.success && (!accepts || accepts(entryKey, parsed.data))) {
        kept[entryKey] = parsed.data
        continue
      }
      reportDrop(entryKey)
    }
    return { ...kept }
  }) as z.ZodType<Record<string, z.output<V>>, unknown>
}

function salvaged(name: string, schema: z.ZodType, fallback: () => unknown): z.ZodType {
  return z.unknown().transform((raw, ctx) => {
    if (raw === undefined) {
      ctx.addIssue({ code: 'custom', message: 'required', input: raw })
      return z.NEVER
    }
    const parsed = parseEntryAt(name, schema, raw)
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
