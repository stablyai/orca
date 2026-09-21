import { z } from 'zod'

/**
 * Data contract between a plugin task source and the Tasks surface. The
 * plugin returns data; core renders it. Electron-free so desktop main, the
 * headless runtime, the relay, and tests validate identically.
 *
 * EXPERIMENTAL until pluginApi v1 freezes.
 */

export const PLUGIN_TASK_SOURCE_ERROR_CODES = [
  'not_configured',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'unavailable',
  'validation',
  'conflict'
] as const

export type PluginTaskSourceErrorCode = (typeof PLUGIN_TASK_SOURCE_ERROR_CODES)[number]

const TITLE_MAX = 1024
const BODY_MAX = 128 * 1024
export const PLUGIN_TASK_PAGE_LIMIT = 200

const PRIORITY_MAX = 128
const LABEL_MAX = 128
const LABELS_MAX = 32
const FILTER_LABEL_MAX = 256
const FILTERS_MAX = 16

export const pluginTaskSourceErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum(PLUGIN_TASK_SOURCE_ERROR_CODES),
  message: z.string().max(4096)
})

export type PluginTaskSourceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PluginTaskSourceErrorCode; message: string }

/** One envelope for every method, so a caller can never read a failure as data. */
export function pluginTaskSourceResultSchema<T extends z.ZodTypeAny>(
  data: T
): z.ZodType<PluginTaskSourceResult<z.infer<T>>> {
  const union = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    pluginTaskSourceErrorSchema
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the union's runtime shape is exactly PluginTaskSourceResult<T>; Zod v4's discriminatedUnion generic cannot be proven assignable to the named union (TS2322), so the cast only names what the schema already validates.
  return union as unknown as z.ZodType<PluginTaskSourceResult<z.infer<T>>>
}

export const pluginTaskScopeSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(TITLE_MAX),
  isDefault: z.boolean().optional()
})

export const pluginTaskIdentitySchema = z.object({
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(TITLE_MAX),
  avatarUrl: z.string().max(2048).nullable().optional()
})

export const pluginTaskItemSchema = z.object({
  /** Provider-native and opaque to core. */
  id: z.string().min(1).max(512),
  key: z.string().min(1).max(128),
  title: z.string().max(TITLE_MAX),
  state: z.object({
    name: z.string().min(1).max(256),
    category: z.enum(['todo', 'in-progress', 'done', 'unknown'])
  }),
  assignee: pluginTaskIdentitySchema.nullable(),
  url: z.string().max(2048).nullable(),
  updatedAt: z.string().datetime().nullable(),
  scopeId: z.string().max(512).nullable(),
  /** Display string, not an enum: providers disagree on vocabulary (Azure
   *  DevOps uses '1'-'4', Jira uses 'High'/'Medium'). Never parsed, only shown. */
  priority: z.string().max(PRIORITY_MAX).nullable().optional(),
  labels: z.array(z.string().min(1).max(LABEL_MAX)).max(LABELS_MAX).optional()
})

export const pluginTaskPageSchema = z.object({
  items: z.array(pluginTaskItemSchema).max(PLUGIN_TASK_PAGE_LIMIT),
  nextCursor: z.string().max(4096).nullable()
})

/** getItem's shape: an item plus its body. Never `'html'` — a plugin that
 *  owns HTML (e.g. Azure DevOps's System.Description) must convert to
 *  markdown itself; the renderer only ever trusts text/markdown. */
export const pluginTaskItemDetailSchema = pluginTaskItemSchema.extend({
  description: z.string().max(BODY_MAX).nullable().optional(),
  descriptionFormat: z.enum(['text', 'markdown']).default('text'),
  /** Work item type name (e.g. 'Bug', 'User Story'), shown in the panel header. */
  type: z.string().max(256).nullable().optional()
})

export const pluginTaskCommentSchema = z.object({
  id: z.string().min(1).max(512),
  author: pluginTaskIdentitySchema,
  body: z.string().max(BODY_MAX),
  /** A source that converts a provider's HTML comment needs a format that says
   *  so, as `descriptionFormat` does for a description. `'html'` predates the
   *  no-HTML decision taken for descriptions and is not removed here. */
  bodyFormat: z.enum(['text', 'markdown', 'html']),
  createdAt: z.string().datetime()
})

export const pluginTaskTransitionSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256)
})

/** What kind of work a new item is. Scope-dependent: Azure DevOps offers a
 *  different set per project, and Jira per project too. */
export const pluginTaskItemTypeSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256)
})

export const pluginTaskSourceStatusSchema = z.object({
  connected: z.boolean(),
  accountLabel: z.string().max(TITLE_MAX).nullable(),
  /** A connected source with a caveat. An unreachable or unauthorized source
   *  resolves `ok: false` instead and is never reported as connected. */
  notice: z
    .object({
      code: z.enum(PLUGIN_TASK_SOURCE_ERROR_CODES),
      message: z.string().max(4096)
    })
    .nullable(),
  /** Core renders only the controls a provider actually offers, so an
   *  unsupported verb cannot become a dead button. */
  supports: z.object({
    create: z.boolean(),
    comment: z.boolean(),
    transition: z.boolean(),
    assign: z.boolean(),
    editTitle: z.boolean(),
    editDescription: z.boolean()
  }),
  /** Named presets the source offers (Jira's Assigned/Reported/All Open/Done
   *  are Jira's own vocabulary), rendered as chips. Omitted when none apply. */
  filters: z
    .array(z.object({ id: z.string().min(1).max(512), label: z.string().min(1).max(FILTER_LABEL_MAX) }))
    .max(FILTERS_MAX)
    .optional()
})

export const pluginTaskQuerySchema = z.object({
  /** Empty means the source's own default scope. */
  scopeIds: z.array(z.string().min(1).max(512)).max(64),
  search: z.string().max(1024).nullable(),
  cursor: z.string().max(4096).nullable(),
  limit: z.number().int().positive().max(PLUGIN_TASK_PAGE_LIMIT),
  /** Which declared status.filters entry is active. Absent/null means the
   *  source's own default. */
  filterId: z.string().min(1).max(512).nullable().optional()
})

/** Which scope's types to offer. Required, not optional: a source's default
 *  scope would answer with types that do not apply to the scope the caller is
 *  about to create in. */
export const pluginTaskItemTypeQuerySchema = z.object({
  scopeId: z.string().min(1).max(512)
})

/** The minimum a provider needs to open a work item. `typeId` names one of
 *  listItemTypes' entries for the same `scopeId`. */
export const pluginTaskCreateSchema = z.object({
  scopeId: z.string().min(1).max(512),
  typeId: z.string().min(1).max(512),
  title: z.string().min(1).max(TITLE_MAX),
  description: z.string().max(BODY_MAX).optional()
})

export const pluginTaskPatchSchema = z
  .object({
    stateId: z.string().min(1).max(512),
    assigneeId: z.string().min(1).max(512).nullable(),
    title: z.string().min(1).max(TITLE_MAX),
    description: z.string().max(BODY_MAX)
  })
  .partial()

export const PLUGIN_TASK_SOURCE_METHODS = [
  'status',
  'listScopes',
  'listItemTypes',
  'listItems',
  'getItem',
  'createItem',
  'listComments',
  'addComment',
  'listTransitions',
  'listAssignees',
  'applyPatch'
] as const

export type PluginTaskSourceMethod = (typeof PLUGIN_TASK_SOURCE_METHODS)[number]

/** A `method` taken off the wire is an untyped string; narrow it before any
 *  lookup keyed by PluginTaskSourceMethod, or an unknown key reads as
 *  `undefined` and the caller crashes on the next `.` access. */
export function isPluginTaskSourceMethod(value: string): value is PluginTaskSourceMethod {
  return (PLUGIN_TASK_SOURCE_METHODS as readonly string[]).includes(value)
}

/** What each method's `data` must be. A new method without an entry here is a
 *  compile error, so no call can reach a consumer unvalidated. */
export const PLUGIN_TASK_SOURCE_RESULT_SCHEMAS: Record<PluginTaskSourceMethod, z.ZodTypeAny> = {
  status: pluginTaskSourceStatusSchema,
  listScopes: z.array(pluginTaskScopeSchema),
  listItemTypes: z.array(pluginTaskItemTypeSchema),
  listItems: pluginTaskPageSchema,
  getItem: pluginTaskItemDetailSchema,
  /** The created item, so a caller can show it without a second round trip. */
  createItem: pluginTaskItemSchema,
  listComments: z.array(pluginTaskCommentSchema),
  addComment: pluginTaskCommentSchema,
  listTransitions: z.array(pluginTaskTransitionSchema),
  listAssignees: z.array(pluginTaskIdentitySchema),
  applyPatch: pluginTaskItemSchema
}

export type PluginTaskScope = z.infer<typeof pluginTaskScopeSchema>
export type PluginTaskIdentity = z.infer<typeof pluginTaskIdentitySchema>
export type PluginTaskItem = z.infer<typeof pluginTaskItemSchema>
export type PluginTaskItemDetail = z.infer<typeof pluginTaskItemDetailSchema>
export type PluginTaskPage = z.infer<typeof pluginTaskPageSchema>
export type PluginTaskComment = z.infer<typeof pluginTaskCommentSchema>
export type PluginTaskTransition = z.infer<typeof pluginTaskTransitionSchema>
export type PluginTaskItemType = z.infer<typeof pluginTaskItemTypeSchema>
export type PluginTaskItemTypeQuery = z.infer<typeof pluginTaskItemTypeQuerySchema>
export type PluginTaskCreate = z.infer<typeof pluginTaskCreateSchema>
export type PluginTaskSourceStatus = z.infer<typeof pluginTaskSourceStatusSchema>
export type PluginTaskQuery = z.infer<typeof pluginTaskQuerySchema>
export type PluginTaskPatch = z.infer<typeof pluginTaskPatchSchema>
