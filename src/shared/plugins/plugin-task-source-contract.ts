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

export const pluginTaskSourceErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum(PLUGIN_TASK_SOURCE_ERROR_CODES),
  message: z.string().max(4096)
})

/** One envelope for every method, so a caller can never read a failure as data. */
export function pluginTaskSourceResultSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    pluginTaskSourceErrorSchema
  ])
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
  scopeId: z.string().max(512).nullable()
})

export const pluginTaskPageSchema = z.object({
  items: z.array(pluginTaskItemSchema).max(PLUGIN_TASK_PAGE_LIMIT),
  nextCursor: z.string().max(4096).nullable()
})

export const pluginTaskCommentSchema = z.object({
  id: z.string().min(1).max(512),
  author: pluginTaskIdentitySchema,
  body: z.string().max(BODY_MAX),
  bodyFormat: z.enum(['text', 'html']),
  createdAt: z.string().datetime()
})

export const pluginTaskTransitionSchema = z.object({
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
    comment: z.boolean(),
    transition: z.boolean(),
    assign: z.boolean(),
    editTitle: z.boolean(),
    editDescription: z.boolean()
  })
})

export const pluginTaskQuerySchema = z.object({
  /** Empty means the source's own default scope. */
  scopeIds: z.array(z.string().min(1).max(512)).max(64),
  search: z.string().max(1024).nullable(),
  cursor: z.string().max(4096).nullable(),
  limit: z.number().int().positive().max(PLUGIN_TASK_PAGE_LIMIT)
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
  'listItems',
  'getItem',
  'listComments',
  'addComment',
  'listTransitions',
  'listAssignees',
  'applyPatch'
] as const

export type PluginTaskSourceMethod = (typeof PLUGIN_TASK_SOURCE_METHODS)[number]
export type PluginTaskScope = z.infer<typeof pluginTaskScopeSchema>
export type PluginTaskIdentity = z.infer<typeof pluginTaskIdentitySchema>
export type PluginTaskItem = z.infer<typeof pluginTaskItemSchema>
export type PluginTaskPage = z.infer<typeof pluginTaskPageSchema>
export type PluginTaskComment = z.infer<typeof pluginTaskCommentSchema>
export type PluginTaskTransition = z.infer<typeof pluginTaskTransitionSchema>
export type PluginTaskSourceStatus = z.infer<typeof pluginTaskSourceStatusSchema>
export type PluginTaskQuery = z.infer<typeof pluginTaskQuerySchema>
export type PluginTaskPatch = z.infer<typeof pluginTaskPatchSchema>
