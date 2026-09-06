import { z } from 'zod'

type AnySchema = z.ZodType<unknown>
type SchemaDef = Record<string, unknown> & { type: string }

const rewritten = new WeakMap<object, AnySchema>()

/**
 * Rewrites a shell-authored payload schema so an additive change in a newer APK degrades instead of
 * bricking an older page. The shell (APK) and the page (served by the desktop) ship from different
 * releases, and a page parse failure is permanent: `invalid_message` is not retryable and nothing
 * re-subscribes. Four relaxations, each the forward-compatible reading of a closed shape: unknown
 * object keys are stripped rather than rejected, a member an array-of-unions cannot classify is
 * dropped rather than failing the whole array, an unknown value for an optional/nullable closed
 * set collapses to absent rather than failing its parent, and an optional/nullable discriminated
 * union the page cannot classify collapses the same way.
 *
 * Only the shell->page direction. Page->shell request schemas stay `.strict()`: there the shell is
 * the authority and a loud `invalid_request` is the security fence.
 */
export function tolerantMobileWebShellPayload<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return loosen(schema as AnySchema) as unknown as z.ZodType<T>
}

function loosen(schema: AnySchema): AnySchema {
  const cached = rewritten.get(schema)
  if (cached) {
    return cached
  }
  const built = rebuild(schema)
  rewritten.set(schema, built)
  return built
}

function definitionOf(schema: AnySchema): SchemaDef {
  return (schema as unknown as { _zod: { def: SchemaDef } })._zod.def
}

function cloned(schema: AnySchema, def: SchemaDef): AnySchema {
  return (schema as unknown as { clone: (def: SchemaDef) => AnySchema }).clone(def)
}

function rebuild(schema: AnySchema): AnySchema {
  const def = definitionOf(schema)
  switch (def.type) {
    case 'object':
      return rebuiltObject(schema, def)
    case 'array':
      return rebuiltArray(schema, def)
    case 'union':
      return cloned(schema, { ...def, options: (def.options as AnySchema[]).map(loosen) })
    case 'optional':
    case 'nullable':
      return rebuiltClosedSetWrapper(schema, def)
    case 'nonoptional':
    case 'readonly':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'promise':
      return cloned(schema, { ...def, innerType: loosen(def.innerType as AnySchema) })
    case 'lazy': {
      const getter = def.getter as () => AnySchema
      return cloned(schema, { ...def, getter: () => loosen(getter()) })
    }
    case 'pipe':
      return cloned(schema, {
        ...def,
        in: loosen(def.in as AnySchema),
        out: loosen(def.out as AnySchema)
      })
    case 'intersection':
      return cloned(schema, {
        ...def,
        left: loosen(def.left as AnySchema),
        right: loosen(def.right as AnySchema)
      })
    case 'record':
    case 'map':
    case 'set':
      return cloned(schema, { ...def, valueType: loosen(def.valueType as AnySchema) })
    case 'tuple':
      return cloned(schema, {
        ...def,
        items: (def.items as AnySchema[]).map(loosen),
        rest: def.rest ? loosen(def.rest as AnySchema) : def.rest
      })
    default:
      return schema
  }
}

function rebuiltObject(schema: AnySchema, def: SchemaDef): AnySchema {
  const shape = Object.fromEntries(
    Object.entries(def.shape as Record<string, AnySchema>).map(([key, value]) => [
      key,
      loosen(value)
    ])
  )
  const catchall = def.catchall as AnySchema | undefined
  const strict = catchall !== undefined && definitionOf(catchall).type === 'never'
  return cloned(schema, {
    ...def,
    shape,
    catchall: strict || catchall === undefined ? undefined : loosen(catchall)
  })
}

/** Length checks stay on the raw array so a wire-size cap still rejects before any member parses. */
function rebuiltArray(schema: AnySchema, def: SchemaDef): AnySchema {
  const element = loosen(def.element as AnySchema)
  if (!isUnion(def.element as AnySchema)) {
    return cloned(schema, { ...def, element })
  }
  return cloned(schema, { ...def, element: z.unknown() }).transform((items) =>
    (items as unknown[]).flatMap((item) => {
      const parsed = element.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  ) as unknown as AnySchema
}

/** An unknown member of a closed set reads as "absent" so it cannot fail the payload around it. */
function rebuiltClosedSetWrapper(schema: AnySchema, def: SchemaDef): AnySchema {
  const inner = def.innerType as AnySchema
  const absent = (def.type === 'nullable' ? null : undefined) as never
  const loosened = loosen(inner)
  if (isClosedSet(inner)) {
    return cloned(schema, { ...def, innerType: loosened }).catch(absent)
  }
  const unclassified = unclassifiedMemberOf(loosened, absent)
  return cloned(schema, {
    ...def,
    innerType: unclassified ? z.union([loosened, unclassified]) : loosened
  })
}

/**
 * A discriminated union is a closed set one level in, so a member named by a discriminant this build
 * has never heard of is the same forward-compatible shape as an unknown enum value and reads as
 * absent. `init.resumeRoute` is the case that made this load-bearing: a page that failed the whole
 * envelope over a route it could have ignored lost every grant with it. Scoped to an unrecognized
 * discriminant on purpose -- a member the page CAN name but whose fields break their bounds is a
 * sender bug, not version skew, and still fails loudly.
 */
function unclassifiedMemberOf(schema: AnySchema, absent: never): AnySchema | null {
  const def = definitionOf(schema)
  if (def.type !== 'union' || typeof def.discriminator !== 'string') {
    return null
  }
  const discriminator = def.discriminator
  const known = (schema as unknown as { _zod: { propValues?: Record<string, Set<unknown>> } })._zod
    .propValues?.[discriminator]
  if (!known || known.size === 0) {
    return null
  }
  return z
    .unknown()
    .refine(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        !known.has((value as Record<string, unknown>)[discriminator])
    )
    .transform(() => absent) as unknown as AnySchema
}

function isUnion(schema: AnySchema): boolean {
  return definitionOf(schema).type === 'union'
}

function isClosedSet(schema: AnySchema): boolean {
  const def = definitionOf(schema)
  if (def.type === 'enum' || def.type === 'literal') {
    return true
  }
  if (def.type === 'optional' || def.type === 'nullable') {
    return isClosedSet(def.innerType as AnySchema)
  }
  return def.type === 'union' && (def.options as AnySchema[]).every(isClosedSet)
}
