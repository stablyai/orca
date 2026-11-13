import { z, type RefinementCtx } from 'zod'
import { formatPluginSchemaPath } from './plugin-schema-issues'
import { PLUGIN_ENUM_SINCE_KEY } from './plugin-engine-floor-keys'
import { orcaEngineRangeSchema, satisfiesOrcaEngineRange } from './plugin-manifest-engine-range'
import { isPluginJsonObject } from './plugin-json-object'
import { PLUGIN_UNRELEASED_SINCE } from './plugin-schema-field-docs'

type Floor = { version: string; path: readonly PropertyKey[] }

function newer(
  current: Floor | null,
  version: unknown,
  path: readonly PropertyKey[],
  allowUnreleased: boolean
): Floor | null {
  if (
    typeof version !== 'string' ||
    current?.version === PLUGIN_UNRELEASED_SINCE ||
    (allowUnreleased && version === PLUGIN_UNRELEASED_SINCE)
  ) {
    return current
  }
  return current === null ||
    version === PLUGIN_UNRELEASED_SINCE ||
    !satisfiesOrcaEngineRange(current.version, `>=${version}`)
    ? { version, path }
    : current
}

function sinceOf(
  schema: z.core.$ZodType,
  value: unknown,
  path: readonly PropertyKey[],
  floor: Floor | null,
  allowUnreleased: boolean
) {
  const meta = z.globalRegistry.get(schema)
  let next = newer(floor, meta?.['x-orca-since'], path, allowUnreleased)
  const enumSince = meta?.[PLUGIN_ENUM_SINCE_KEY]
  if (typeof value === 'string' && isPluginJsonObject(enumSince)) {
    next = newer(next, enumSince[value], path, allowUnreleased)
  }
  return next
}

/** Newest release among every field and enum value the parsed manifest actually uses. Empty
 *  lists and absent optional fields count as unused. */
function walk(
  schema: z.core.$ZodType,
  value: unknown,
  path: readonly PropertyKey[],
  floor: Floor | null,
  allowUnreleased: boolean
): Floor | null {
  const current = sinceOf(schema, value, path, floor, allowUnreleased)
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch
  ) {
    return walk(schema.def.innerType, value, path, current, allowUnreleased)
  }
  if (schema instanceof z.ZodPipe) {
    return walk(schema.def.in, value, path, current, allowUnreleased)
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    return value.reduce<Floor | null>(
      (acc, item, index) => walk(schema.def.element, item, [...path, index], acc, allowUnreleased),
      current
    )
  }
  if (schema instanceof z.ZodObject && isPluginJsonObject(value)) {
    return Object.entries(schema.def.shape).reduce<Floor | null>((acc, [key, field]) => {
      const child = value[key]
      if (child === undefined || (Array.isArray(child) && child.length === 0)) {
        return acc
      }
      return walk(field, child, [...path, key], acc, allowUnreleased)
    }, current)
  }
  return current
}

/** The release a manifest must at least declare in engines.orca, and the field that needs it. */
export function pluginEngineFloor(
  schema: z.core.$ZodType,
  manifest: unknown,
  allowUnreleased = false
): { version: string; field: string } | null {
  // Why skip the root: its own since describes the file format, which each field repeats.
  const floor = walk(schema, manifest, [], null, allowUnreleased)
  return floor ? { version: floor.version, field: formatPluginSchemaPath(floor.path) } : null
}

function unreleasedFieldIssue(field: string, ctx: RefinementCtx): void {
  ctx.addIssue({
    code: 'custom',
    path: ['engines', 'orca'],
    message: `${field} is unreleased; use --allow-unreleased for source development only. Maintainers must assign its first release before publishing`
  })
}

/** Legacy manifests retain their numbered-floor policy, but cannot publish source-only fields. */
export function validatePluginUnreleasedFields(
  schema: z.core.$ZodType,
  manifest: unknown,
  ctx: RefinementCtx
): void {
  const floor = pluginEngineFloor(schema, manifest)
  if (floor?.version === PLUGIN_UNRELEASED_SINCE) {
    unreleasedFieldIssue(floor.field, ctx)
  }
}

/** Why enforced: an older Orca reports "requires Orca >=X" only when engines.orca covers every
 *  field the plugin uses, so authors may not under-declare it. */
export function validatePluginEngineFloor(
  schema: z.core.$ZodType,
  manifest: { engines: { orca: string } },
  ctx: RefinementCtx,
  allowUnreleased = false
): void {
  // Why: an unreadable range already has its own issue; a floor message on top is noise.
  if (!orcaEngineRangeSchema.safeParse(manifest.engines.orca).success) {
    return
  }
  const floor = pluginEngineFloor(schema, manifest, allowUnreleased)
  const declared = manifest.engines.orca.slice(2)
  if (floor?.version === PLUGIN_UNRELEASED_SINCE) {
    unreleasedFieldIssue(floor.field, ctx)
  } else if (floor && !satisfiesOrcaEngineRange(declared, `>=${floor.version}`)) {
    ctx.addIssue({
      code: 'custom',
      path: ['engines', 'orca'],
      message: `must be at least >=${floor.version}, because ${floor.field} needs Orca ${floor.version}`
    })
  }
}
