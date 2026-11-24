import { z } from 'zod'
import { PLUGIN_EVENT_NAMES } from '../contributions/plugin-event-contribution'

/**
 * A plugin's panels and its own worker: panels call `plugin.request(name, input)` (the
 * `plugin.request` host method), the worker answers with `orca.panels.handle(name, ...)` and
 * pushes with `orca.panels.post(event, payload)`. Same plugin only; main routes both ways.
 */

/** Request and event names: what authors declare in `PluginRequests` / `PluginPanelEvents`. */
export const pluginBridgeNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'is 1-128 letters, digits, or . _ : -')

export const PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS = 30_000
export const PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS = 120_000
/** What a worker may answer one request with, or post at once; panel inputs ride the 64 KiB lane. */
export const PLUGIN_PANEL_RESULT_MAX_BYTES = 1024 * 1024
export const PLUGIN_PANEL_POST_MAX_BYTES = 256 * 1024
/** Posts per plugin, across its panels. */
export const PLUGIN_PANEL_POST_RATE_LIMIT = { maxMessages: 200, perMs: 10_000 }

/** Who asked: one open panel or editor of the plugin. `id` stays the same while it stays open. */
export const pluginPanelCallerSchema = z.object({
  id: z.string().min(1).max(64),
  surface: z.enum(['panel', 'editor']),
  contributionId: z.string().min(1).max(256)
})
export type PluginPanelCaller = z.infer<typeof pluginPanelCallerSchema>

/** host → worker request `panel.request`. */
export const pluginWorkerPanelRequestParamsSchema = z.object({
  name: pluginBridgeNameSchema,
  input: z.unknown(),
  panel: pluginPanelCallerSchema
})

/** worker → host event `panel.post`; `panel` targets one panel, else every open one. */
export const pluginWorkerPanelPostSchema = z.object({
  event: pluginBridgeNameSchema,
  payload: z.unknown(),
  panel: z.string().min(1).max(64).optional()
})
export type PluginWorkerPanelPost = z.infer<typeof pluginWorkerPanelPostSchema>

/** Which of the plugin's stores changed; values are re-read, never pushed. */
export const PLUGIN_DATA_AREAS = ['storage', 'settings'] as const
export type PluginDataArea = (typeof PLUGIN_DATA_AREAS)[number]

/** host → worker event `data.changed`: a panel or the person changed the plugin's data. */
export const pluginDataChangedSchema = z.object({
  area: z.enum(PLUGIN_DATA_AREAS),
  key: z.string().min(1).max(256)
})
export type PluginDataChanged = z.infer<typeof pluginDataChangedSchema>

/** main → renderer → frame: what an open panel is told, wrapped in the `plugin.push` frame event. */
export const pluginPanelPushSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), event: pluginBridgeNameSchema, payload: z.unknown() }),
  z.object({ kind: z.literal('event'), event: z.enum(PLUGIN_EVENT_NAMES), payload: z.unknown() }),
  z.object({ kind: z.literal('changed'), area: z.enum(PLUGIN_DATA_AREAS), key: z.string() })
])
export type PluginPanelPush = z.infer<typeof pluginPanelPushSchema>
