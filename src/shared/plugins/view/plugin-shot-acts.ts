import { z } from 'zod'

/**
 * `orca plugin shot --act`: input run against the live components panel before the capture, in
 * the test kit's vocabulary: `press(query)`, `type(query, text, { replace, submit })`,
 * `select(query, value)`, `toggle(query)`, `slide(query, value)`, and the Table and Tree verbs
 * (`sort`, `selectRows`, `activateRow`, `loadMore`, `expand`, `collapse`, `selectItem`,
 * `activateItem`). Queries match as the kit's do, with plain strings.
 */

export const PLUGIN_SHOT_MAX_ACTS = 20
const QUERY_TEXT_MAX = 200
const TYPE_TEXT_MAX = 500
// A Table's `selectRows`; well above a person's multi-select.
const PLUGIN_SHOT_MAX_ROW_KEYS = 200

const queryText = z.string().min(1).max(QUERY_TEXT_MAX)

export const pluginShotQuerySchema = z
  .strictObject({
    type: queryText.optional(),
    role: queryText.optional(),
    text: queryText.optional(),
    label: queryText.optional(),
    testId: queryText.optional()
  })
  .refine((query) => Object.values(query).some((value) => value !== undefined), {
    message: 'a query needs at least one of type, role, text, label or testId'
  })

export type PluginShotQuery = z.infer<typeof pluginShotQuerySchema>

const keyText = z.string().min(1).max(QUERY_TEXT_MAX)

const ACT_SCHEMAS = {
  press: z.strictObject({ press: pluginShotQuerySchema }),
  type: z.strictObject({
    type: pluginShotQuerySchema,
    text: z.string().max(TYPE_TEXT_MAX),
    replace: z.boolean().optional(),
    submit: z.boolean().optional()
  }),
  select: z.strictObject({ select: pluginShotQuerySchema, value: z.string().max(QUERY_TEXT_MAX) }),
  toggle: z.strictObject({ toggle: pluginShotQuerySchema }),
  slide: z.strictObject({ slide: pluginShotQuerySchema, value: z.number().finite() }),
  sort: z.strictObject({ sort: pluginShotQuerySchema, column: keyText }),
  selectRows: z.strictObject({
    selectRows: pluginShotQuerySchema,
    keys: z.array(keyText).max(PLUGIN_SHOT_MAX_ROW_KEYS)
  }),
  activateRow: z.strictObject({ activateRow: pluginShotQuerySchema, key: keyText }),
  loadMore: z.strictObject({ loadMore: pluginShotQuerySchema }),
  expand: z.strictObject({ expand: pluginShotQuerySchema, key: keyText }),
  collapse: z.strictObject({ collapse: pluginShotQuerySchema, key: keyText }),
  selectItem: z.strictObject({ selectItem: pluginShotQuerySchema, key: keyText }),
  activateItem: z.strictObject({ activateItem: pluginShotQuerySchema, key: keyText })
}

export const pluginShotActSchema = z.union([
  ACT_SCHEMAS.press,
  ACT_SCHEMAS.type,
  ACT_SCHEMAS.select,
  ACT_SCHEMAS.toggle,
  ACT_SCHEMAS.slide,
  ACT_SCHEMAS.sort,
  ACT_SCHEMAS.selectRows,
  ACT_SCHEMAS.activateRow,
  ACT_SCHEMAS.loadMore,
  ACT_SCHEMAS.expand,
  ACT_SCHEMAS.collapse,
  ACT_SCHEMAS.selectItem,
  ACT_SCHEMAS.activateItem
])

export type PluginShotAct = z.infer<typeof pluginShotActSchema>

export const pluginShotActsSchema = z.array(pluginShotActSchema).min(1).max(PLUGIN_SHOT_MAX_ACTS)

/** One act's outcome, in order; acts after a failed one are not run. */
export type PluginShotActResult = { ok: true } | { ok: false; error: string }

export const pluginShotActResultSchema: z.ZodType<PluginShotActResult> = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) })
])

const VERBS = [
  'press',
  'type',
  'select',
  'toggle',
  'slide',
  'sort',
  'selectRows',
  'activateRow',
  'loadMore',
  'expand',
  'collapse',
  'selectItem',
  'activateItem'
] as const satisfies readonly (keyof typeof ACT_SCHEMAS)[]

function issueOf(index: number, value: unknown): string {
  const where = `action ${index + 1}`
  const verb =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? VERBS.find((name) => name in value)
      : undefined
  if (!verb) {
    return `${where}: expected an object with one of ${VERBS.join(', ')}`
  }
  const parsed = ACT_SCHEMAS[verb].safeParse(value)
  const first = parsed.success ? undefined : parsed.error.issues[0]
  const path = first?.path.length ? ` (${first.path.join('.')})` : ''
  return `${where} (${verb})${path}: ${first?.message ?? 'invalid'}`
}

/** `--act`'s JSON: a list (or one act) checked here, so a typo fails before Orca opens anything. */
export function parsePluginShotActs(
  json: string
): { ok: true; acts: PluginShotAct[] } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : 'invalid'}` }
  }
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) {
    return { ok: false, error: 'the list of actions is empty' }
  }
  if (list.length > PLUGIN_SHOT_MAX_ACTS) {
    return { ok: false, error: `at most ${PLUGIN_SHOT_MAX_ACTS} actions` }
  }
  const acts: PluginShotAct[] = []
  for (const [index, entry] of list.entries()) {
    const parsed = pluginShotActSchema.safeParse(entry)
    if (!parsed.success) {
      return { ok: false, error: issueOf(index, entry) }
    }
    acts.push(parsed.data)
  }
  return { ok: true, acts }
}
