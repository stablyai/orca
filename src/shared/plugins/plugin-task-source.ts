import { z } from 'zod'
import { pluginIdSchema } from './plugin-manifest-fields'

/**
 * Plugin task sources: a plugin worker supplies a task list for the Tasks page
 * and, per item, a start recipe that pre-fills Create workspace. The plugin
 * only returns data; Orca owns workspace creation and agent launch, and the
 * user reviews the recipe in the composer before anything is created.
 *
 * Everything crossing from the worker is untrusted, so main validates every
 * result against these schemas before it reaches a renderer.
 *
 * EXPERIMENTAL, like the rest of pluginApi 1.
 */

export const PLUGIN_TASK_SOURCE_LIMIT = 8
export const PLUGIN_TASK_LIST_ITEM_LIMIT = 500
export const PLUGIN_TASK_FILTER_LIMIT = 8
export const PLUGIN_TASK_FILTER_OPTION_LIMIT = 100
export const PLUGIN_TASK_BODY_MAX_CHARS = 512 * 1024
export const PLUGIN_TASK_AGENT_PROMPT_MAX_CHARS = 16 * 1024
/** First list/get can activate a cold worker that reads many files. */
export const PLUGIN_TASK_SOURCE_INVOKE_TIMEOUT_MS = 60_000

export const pluginTaskSourceContributionSchema = z
  .object({
    id: pluginIdSchema,
    title: z.string().min(1).max(64),
    /** Lucide icon name shown on the Tasks source button. */
    icon: z.string().min(1).max(64).optional()
  })
  .strict()

export type PluginTaskSourceContribution = z.infer<typeof pluginTaskSourceContributionSchema>

export const PLUGIN_TASK_STATUS_TONES = [
  'open',
  'active',
  'blocked',
  'review',
  'done',
  'closed'
] as const

export type PluginTaskStatusTone = (typeof PLUGIN_TASK_STATUS_TONES)[number]

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

const filterIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case')

export const PLUGIN_TASK_LINK_METADATA_LIMIT = 8

export const pluginTaskLinkMetadataSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must be an identifier'),
    z.string().min(1).max(4096)
  )
  .refine(
    (value) => Object.keys(value).length <= PLUGIN_TASK_LINK_METADATA_LIMIT,
    'too many metadata entries'
  )

export const pluginTaskStartRecipeSchema = z
  .object({
    /** Suggested workspace name; the user can edit it in the composer. */
    workspaceName: z.string().min(1).max(128).optional(),
    /** Draft typed into the agent after launch. Never submitted on its own. */
    agentPrompt: z.string().min(1).max(PLUGIN_TASK_AGENT_PROMPT_MAX_CHARS).optional(),
    /** Branch the new workspace starts from. */
    baseRef: z.string().min(1).max(512).optional(),
    /** Preselects the Orca project whose folder is this path. */
    projectPath: z.string().min(1).max(4096).optional(),
    /**
     * Where the project's files come from, e.g. a Git remote URL. Without `projectPath`, Orca
     * preselects a project from there; if it has none, Start says so instead of using another one.
     */
    projectSource: z.string().min(1).max(512).optional(),
    /** Agent session options for the launch (e.g. Claude's --model/--effort); agents that lack one ignore it. */
    sessionOptions: z
      .object({
        /** Agent id (e.g. `claude`) the options are written for; other agents launch without them. */
        agent: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(128).optional(),
        effort: z.string().min(1).max(32).optional()
      })
      .strict()
      .optional(),
    /** Small notes kept with the workspace's link to this item. */
    linkMetadata: pluginTaskLinkMetadataSchema.optional()
  })
  .strict()

export type PluginTaskStartRecipe = z.infer<typeof pluginTaskStartRecipeSchema>

export const pluginTaskItemSchema = z
  .object({
    id: z.string().min(1).max(512),
    title: z.string().min(1).max(512),
    status: z
      .object({
        label: z.string().min(1).max(64),
        tone: z.enum(PLUGIN_TASK_STATUS_TONES)
      })
      .strict()
      .optional(),
    priority: z.string().min(1).max(32).optional(),
    owner: z.string().min(1).max(256).optional(),
    labels: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** ISO-8601 date or date-time. */
    updatedAt: z.string().min(1).max(64).optional(),
    summary: z.string().max(1024).optional(),
    url: z.string().max(2048).refine(isHttpUrl, 'must be an http(s) URL').optional(),
    /** Absent means the item cannot start a workspace. */
    start: pluginTaskStartRecipeSchema.optional(),
    /** Shown instead of a Start action when `start` is absent. */
    startBlockedReason: z.string().min(1).max(256).optional()
  })
  .strict()

export type PluginTaskItem = z.infer<typeof pluginTaskItemSchema>

export const pluginTaskFilterSchema = z
  .object({
    id: filterIdSchema,
    label: z.string().min(1).max(64),
    options: z
      .array(
        z
          .object({
            value: z.string().max(256),
            label: z.string().min(1).max(128),
            count: z.number().int().nonnegative().optional()
          })
          .strict()
      )
      .min(1)
      .max(PLUGIN_TASK_FILTER_OPTION_LIMIT),
    defaultValue: z.string().max(256).optional()
  })
  .strict()

export type PluginTaskFilter = z.infer<typeof pluginTaskFilterSchema>

export const pluginTaskListParamsSchema = z
  .object({
    query: z.string().max(512).default(''),
    filters: z
      .record(filterIdSchema, z.string().max(256))
      .refine((value) => Object.keys(value).length <= PLUGIN_TASK_FILTER_LIMIT, 'too many filters')
      .default({}),
    cursor: z.string().min(1).max(1024).optional()
  })
  .strict()

export type PluginTaskListParams = z.infer<typeof pluginTaskListParamsSchema>
export type PluginTaskListParamsInput = z.input<typeof pluginTaskListParamsSchema>

export const pluginTaskListResultSchema = z
  .object({
    items: z.array(pluginTaskItemSchema).max(PLUGIN_TASK_LIST_ITEM_LIMIT),
    nextCursor: z.string().min(1).max(1024).optional(),
    /** Filters the source offers; selected values come back in list params. A remembered value missing here is dropped. */
    filters: z.array(pluginTaskFilterSchema).max(PLUGIN_TASK_FILTER_LIMIT).optional(),
    /** One-line status the source wants shown above the list. */
    notice: z.string().min(1).max(512).optional()
  })
  .strict()

export type PluginTaskListResult = z.infer<typeof pluginTaskListResultSchema>

export const pluginTaskGetParamsSchema = z.object({ itemId: z.string().min(1).max(512) }).strict()

export type PluginTaskGetParams = z.infer<typeof pluginTaskGetParamsSchema>

export const pluginTaskDetailSchema = z
  .object({
    item: pluginTaskItemSchema,
    bodyMarkdown: z.string().max(PLUGIN_TASK_BODY_MAX_CHARS).optional()
  })
  .strict()

export type PluginTaskDetail = z.infer<typeof pluginTaskDetailSchema>

export const PLUGIN_TASK_SOURCE_OPERATIONS = ['list', 'get'] as const

export type PluginTaskSourceOperation = (typeof PLUGIN_TASK_SOURCE_OPERATIONS)[number]

/** Renderer/RPC request to a plugin task source; params are re-parsed per operation. */
export const pluginTaskSourceRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      pluginKey: z.string().min(1).max(512),
      sourceId: pluginIdSchema,
      operation: z.literal('list'),
      params: pluginTaskListParamsSchema
    })
    .strict(),
  z
    .object({
      pluginKey: z.string().min(1).max(512),
      sourceId: pluginIdSchema,
      operation: z.literal('get'),
      params: pluginTaskGetParamsSchema
    })
    .strict()
])

export type PluginTaskSourceRequest = z.input<typeof pluginTaskSourceRequestSchema>

export type PluginTaskSourceResponse<O extends PluginTaskSourceOperation> = O extends 'list'
  ? PluginTaskListResult
  : PluginTaskDetail

/** Validates an untrusted worker result for one operation. */
export function parsePluginTaskSourceResult(
  operation: PluginTaskSourceOperation,
  value: unknown
): { ok: true; value: PluginTaskListResult | PluginTaskDetail } | { ok: false; error: string } {
  const schema = operation === 'list' ? pluginTaskListResultSchema : pluginTaskDetailSchema
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    return { ok: true, value: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid result'}` }
}
