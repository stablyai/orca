import { z } from 'zod'
import {
  PLUGIN_COMMAND_LIMIT,
  PLUGIN_EVENT_NAMES,
  pluginCommandIdSchema
} from '../manifest/plugin-manifest'
import { PLUGIN_CAPABILITY_KINDS } from '../capabilities/plugin-capabilities'
import { pluginEvent, type PluginEvent } from '../frames/plugin-protocol'

/**
 * The worker fork channel, on the shared envelope (plugin-protocol.ts). Validate both sides:
 * third-party worker code cannot supply trusted structure. Host calls are the worker's `req`s;
 * the methods and events below are the host's lifecycle traffic.
 */

export const WORKER_EVENTS = {
  /** host → worker, {@link PluginWorkerInit}. */
  init: 'init',
  /** worker → host, `{ commands }` registered on activate. */
  ready: 'ready',
  log: 'log',
  fatal: 'fatal',
  shutdown: 'shutdown'
} as const

/** host → worker requests; the worker answers each with a `res`. */
export const WORKER_METHODS = {
  invokeCommand: 'command.invoke',
  deliverEvent: 'event.deliver'
} as const

export const pluginWorkerInitSchema = z.object({
  /** Qualified `<publisher>.<id>` key. */
  pluginId: z.string().min(1),
  pluginRoot: z.string().min(1),
  mainEntry: z.string().min(1),
  /** Worker-side early refusals only; host rechecks every call regardless of declared grants. */
  grantedCapabilities: z.array(z.enum(PLUGIN_CAPABILITY_KINDS))
})

export const pluginWorkerInvokeParamsSchema = z.object({
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const pluginWorkerDeliverParamsSchema = z.object({
  event: z.enum(PLUGIN_EVENT_NAMES),
  payload: z.unknown()
})

export const pluginWorkerReadySchema = z.object({
  /** Command ids the worker registered handlers for (⊆ manifest commands). */
  commands: z.array(pluginCommandIdSchema).max(PLUGIN_COMMAND_LIMIT)
})

export const pluginWorkerLogSchema = z.object({
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(8192)
})

export const pluginWorkerFatalSchema = z.object({ error: z.string().max(8192) })

export type PluginWorkerInit = z.infer<typeof pluginWorkerInitSchema>

const pluginWorkerChildEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal(WORKER_EVENTS.ready), payload: pluginWorkerReadySchema }),
  z.object({ event: z.literal(WORKER_EVENTS.log), payload: pluginWorkerLogSchema }),
  z.object({ event: z.literal(WORKER_EVENTS.fatal), payload: pluginWorkerFatalSchema })
])

/** A worker → host lifecycle event, or null for anything else. */
export function readPluginWorkerEvent(
  message: PluginEvent
): z.infer<typeof pluginWorkerChildEventSchema> | null {
  const parsed = pluginWorkerChildEventSchema.safeParse(message)
  return parsed.success ? parsed.data : null
}

export function pluginWorkerLog(level: 'info' | 'warn' | 'error', message: string): PluginEvent {
  return pluginEvent(WORKER_EVENTS.log, { level, message: message.slice(0, 8192) })
}

export function pluginWorkerFatal(error: string): PluginEvent {
  return pluginEvent(WORKER_EVENTS.fatal, { error: error.slice(0, 8192) })
}

export const PLUGIN_WORKER_READY_TIMEOUT_MS = 10_000
export const PLUGIN_WORKER_INVOKE_TIMEOUT_MS = 30_000
/** Dispose idle workers and refork on their next trigger. */
export const PLUGIN_WORKER_IDLE_REAP_MS = 5 * 60_000
/** Default cap on concurrently-active workers; excess activations queue. */
export const PLUGIN_WORKER_MAX_ACTIVE_DEFAULT = 5
