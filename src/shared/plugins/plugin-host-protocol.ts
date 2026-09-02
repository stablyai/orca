import { z } from 'zod'
import { PLUGIN_COMMAND_LIMIT, PLUGIN_EVENT_NAMES, pluginCommandIdSchema } from './plugin-manifest'
import { PLUGIN_CAPABILITY_KINDS } from './plugin-capabilities'

/**
 * Message protocol between the Orca process and the out-of-process plugin
 * worker (child_process.fork channel). Zod-validated on both sides because
 * the child runs third-party code — nothing it sends is trusted structurally.
 */

export const pluginWorkerInitSchema = z.object({
  type: z.literal('init'),
  /** Qualified `<publisher>.<id>` key. */
  pluginId: z.string().min(1),
  pluginRoot: z.string().min(1),
  mainEntry: z.string().min(1),
  /** Consented capability kinds, so the in-worker SDK can fail fast client-
   *  side; the host re-gates every call regardless. */
  grantedCapabilities: z.array(z.enum(PLUGIN_CAPABILITY_KINDS))
})

export const pluginWorkerInvokeCommandSchema = z.object({
  type: z.literal('invokeCommand'),
  callId: z.number().int().nonnegative(),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const pluginWorkerDeliverEventSchema = z.object({
  type: z.literal('deliverEvent'),
  eventId: z.number().int().nonnegative(),
  event: z.enum(PLUGIN_EVENT_NAMES),
  payload: z.unknown()
})

export const pluginWorkerHostResultSchema = z.object({
  type: z.literal('hostResult'),
  callId: z.number().int().nonnegative(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional()
})

export const pluginWorkerShutdownSchema = z.object({ type: z.literal('shutdown') })

export const pluginWorkerParentMessageSchema = z.discriminatedUnion('type', [
  pluginWorkerInitSchema,
  pluginWorkerInvokeCommandSchema,
  pluginWorkerDeliverEventSchema,
  pluginWorkerHostResultSchema,
  pluginWorkerShutdownSchema
])

export const pluginWorkerReadySchema = z.object({
  type: z.literal('ready'),
  /** Command ids the worker registered handlers for (⊆ manifest commands). */
  commands: z.array(pluginCommandIdSchema).max(PLUGIN_COMMAND_LIMIT)
})

export const pluginWorkerCommandResultSchema = z.object({
  type: z.literal('commandResult'),
  callId: z.number().int().nonnegative(),
  ok: z.boolean(),
  // Why: value crosses a fork() IPC boundary, so it is structured-clone data
  // by construction; zod treats it as opaque and callers re-validate shape.
  value: z.unknown().optional(),
  error: z.string().max(8192).optional()
})

export const pluginWorkerEventAckSchema = z.object({
  type: z.literal('eventAck'),
  eventId: z.number().int().nonnegative()
})

/** Worker→host API call (the plugin SDK's transport for host methods). */
export const pluginWorkerHostCallSchema = z.object({
  type: z.literal('hostCall'),
  callId: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown().optional()
})

export const pluginWorkerLogSchema = z.object({
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(8192)
})

export const pluginWorkerFatalSchema = z.object({
  type: z.literal('fatal'),
  error: z.string().max(8192)
})

export const pluginWorkerChildMessageSchema = z.discriminatedUnion('type', [
  pluginWorkerReadySchema,
  pluginWorkerCommandResultSchema,
  pluginWorkerEventAckSchema,
  pluginWorkerHostCallSchema,
  pluginWorkerLogSchema,
  pluginWorkerFatalSchema
])

export type PluginWorkerParentMessage = z.infer<typeof pluginWorkerParentMessageSchema>
export type PluginWorkerChildMessage = z.infer<typeof pluginWorkerChildMessageSchema>
export type PluginWorkerInit = z.infer<typeof pluginWorkerInitSchema>

export const PLUGIN_WORKER_READY_TIMEOUT_MS = 10_000
export const PLUGIN_WORKER_INVOKE_TIMEOUT_MS = 30_000
/** Idle reap: a worker with no in-flight work for this long is disposed and
 *  re-forked on the next trigger. */
export const PLUGIN_WORKER_IDLE_REAP_MS = 5 * 60_000
/** Default cap on concurrently-active workers; excess activations queue. */
export const PLUGIN_WORKER_MAX_ACTIVE_DEFAULT = 5
