import { z } from 'zod'
import type { PluginCapabilityKind } from '../capabilities/plugin-capabilities'
import type { PluginSurface } from '../frames/plugin-protocol'

/**
 * Host API 1 (`pluginApi: 1`) — the separately-versioned public facade plugins call. Every
 * method carries params AND result schemas plus capability/mutation metadata;
 * handlers (bound in main) delegate to runtime services. The raw runtime-RPC
 * registry is never exposed: its methods have no result schemas and evolve at
 * internal velocity.
 *
 * This table is the single source of truth for the capability gate, which surfaces
 * (worker, panel, editor) may call what, the generated reference and the plugin SDK.
 * Every params schema is strict: an older host refuses a newer flag with `invalid_params`
 * instead of running the call without it. Electron-free by design: desktop
 * main, headless serve, the relay conformance path, and tests all import it.
 *
 * Frozen within major 1: additive only. The policy that binds this
 * table is in docs/reference/plugin-host-api.md, generated from it.
 */

export const PANEL_ACTION_TEXT_MAX_LENGTH = 4096
export const PLUGIN_WORKSPACE_TERMINAL_LIMIT = 50
export const PLUGIN_WORKSPACE_LABEL_MAX_LENGTH = 512
export const PLUGIN_TERMINAL_ID_MAX_LENGTH = 1024

const workspaceReadContextParams = z.strictObject({}).optional()
const workspaceReadContextResult = z
  .object({
    branch: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    displayName: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    /** Terminals of the focused workspace, so callers can address a specific
     *  terminal id — the API has no "active terminal" write target. */
    terminals: z
      .array(
        z
          .object({
            id: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH)
          })
          .strict()
      )
      .max(PLUGIN_WORKSPACE_TERMINAL_LIMIT)
  })
  .strict()
  .nullable()

const terminalSendTextParams = z.strictObject({
  /** Explicit target prevents delayed writes following focus changes into another pane. */
  terminalId: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH),
  text: z.string().min(1).max(PANEL_ACTION_TEXT_MAX_LENGTH),
  enter: z.boolean().default(false)
})
const terminalSendTextResult = z.object({ accepted: z.boolean() })

const notificationsShowParams = z.strictObject({
  title: z.string().min(1).max(120),
  body: z.string().max(1000).optional()
})
const notificationsShowResult = z.object({ delivered: z.boolean() })

const RESERVED_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const storageKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((key) => !RESERVED_STORAGE_KEYS.has(key), 'reserved storage key')
const pluginJsonValueSchema = z.json()
export type PluginJsonValue = z.infer<typeof pluginJsonValueSchema>
/** Caps keep per-plugin storage an honest key-value store, not a database. */
export const PLUGIN_STORAGE_VALUE_MAX_BYTES = 256 * 1024
export const PLUGIN_STORAGE_TOTAL_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_STORAGE_KEY_LIMIT = 1024

const storageGetParams = z.strictObject({ key: storageKeySchema })
const storageGetResult = z.object({ value: pluginJsonValueSchema })
const storageSetParams = z.strictObject({ key: storageKeySchema, value: pluginJsonValueSchema })
const storageSetResult = z.object({ ok: z.literal(true) })
const storageDeleteParams = z.strictObject({ key: storageKeySchema })
const storageDeleteResult = z.object({ ok: z.literal(true) })
const storageKeysParams = z.strictObject({}).optional()
const storageKeysResult = z.object({ keys: z.array(z.string()).max(PLUGIN_STORAGE_KEY_LIMIT) })

const secretsGetParams = z.strictObject({ key: storageKeySchema })
const secretsGetResult = z.object({ value: z.string().nullable() })
const secretsSetParams = z.strictObject({ key: storageKeySchema, value: z.string().max(64 * 1024) })
const secretsSetResult = z.object({ ok: z.literal(true) })
const secretsDeleteParams = z.strictObject({ key: storageKeySchema })
const secretsDeleteResult = z.object({ ok: z.literal(true) })

const settingsGetParams = z.strictObject({}).optional()
const settingsGetResult = z.object({ settings: z.record(z.string(), pluginJsonValueSchema) })
const settingsSetParams = z.strictObject({ key: storageKeySchema, value: pluginJsonValueSchema })
const settingsSetResult = z.object({ ok: z.literal(true) })

export type PluginHostMethodSpec<
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType
> = {
  /** One line for the generated reference. */
  summary: string
  /** Host API minor the method appeared in (`0` for the first set); `api.minor` is the highest. */
  since: number
  /** Minor that deprecated it; it keeps working until the next major. */
  deprecatedSince?: number
  /** Machine-readable resource boundary enforced by the host binding. */
  scope: 'active-workspace' | 'explicit-terminal' | 'plugin-private' | 'desktop'
  capability: PluginCapabilityKind
  /** Mutations are audit-logged with actor `plugin:<id>`. */
  mutation: boolean
  /** Where plugin code may call it; any other surface gets `not_permitted`. */
  surfaces: readonly PluginSurface[]
  params: P
  result: R
}

const ALL_SURFACES = ['worker', 'panel', 'editor'] as const
const WORKER_ONLY = ['worker'] as const

const spec = <P extends z.ZodType, R extends z.ZodType>(
  entry: PluginHostMethodSpec<P, R>
): PluginHostMethodSpec<P, R> => entry

export const PLUGIN_HOST_API = {
  'workspace.readContext': spec({
    summary:
      'Branch, name and terminal ids of the focused workspace, or null when none is focused.',
    since: 0,
    scope: 'active-workspace',
    capability: 'workspace:read',
    mutation: false,
    surfaces: ALL_SURFACES,
    params: workspaceReadContextParams,
    result: workspaceReadContextResult
  }),
  'terminal.sendText': spec({
    summary: 'Types text into one terminal named by id, optionally pressing Enter.',
    since: 0,
    scope: 'explicit-terminal',
    capability: 'terminal:send',
    mutation: true,
    // Why: text plus Enter runs shell commands (local or SSH), so only full-access workers get it.
    surfaces: WORKER_ONLY,
    params: terminalSendTextParams,
    result: terminalSendTextResult
  }),
  'notifications.show': spec({
    summary: 'Shows a desktop notification.',
    since: 0,
    scope: 'desktop',
    capability: 'notifications:show',
    mutation: true,
    surfaces: ALL_SURFACES,
    params: notificationsShowParams,
    result: notificationsShowResult
  }),
  'storage.get': spec({
    summary: "Reads a JSON value from the plugin's private store; null when absent.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: storageGetParams,
    result: storageGetResult
  }),
  'storage.set': spec({
    summary: "Writes a JSON value to the plugin's private store.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: storageSetParams,
    result: storageSetResult
  }),
  'storage.delete': spec({
    summary: "Removes a key from the plugin's private store.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: storageDeleteParams,
    result: storageDeleteResult
  }),
  'storage.keys': spec({
    summary: "Lists the keys in the plugin's private store.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: storageKeysParams,
    result: storageKeysResult
  }),
  'secrets.get': spec({
    summary: "Reads a secret from the plugin's encrypted secrets file; null when absent.",
    since: 0,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: secretsGetParams,
    result: secretsGetResult
  }),
  'secrets.set': spec({
    summary: "Stores a secret in the plugin's encrypted secrets file.",
    since: 0,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: secretsSetParams,
    result: secretsSetResult
  }),
  'secrets.delete': spec({
    summary: "Removes a secret from the plugin's encrypted secrets file.",
    since: 0,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: secretsDeleteParams,
    result: secretsDeleteResult
  }),
  'settings.get': spec({
    summary: 'Reads every setting the plugin owns.',
    since: 0,
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: settingsGetParams,
    result: settingsGetResult
  }),
  'settings.set': spec({
    summary: 'Writes one setting the plugin owns.',
    since: 0,
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: settingsSetParams,
    result: settingsSetResult
  })
}

export type PluginHostApi = typeof PLUGIN_HOST_API
export type PluginHostMethodName = keyof PluginHostApi
/** What a plugin passes; what a handler receives is `z.output` of the same schema. */
export type PluginHostParams<M extends PluginHostMethodName> = z.input<PluginHostApi[M]['params']>
export type PluginHostResult<M extends PluginHostMethodName> = z.output<PluginHostApi[M]['result']>

export const PLUGIN_HOST_METHOD_NAMES = Object.keys(PLUGIN_HOST_API).filter(isPluginHostMethodName)

export function isPluginHostMethodName(name: string): name is PluginHostMethodName {
  return Object.hasOwn(PLUGIN_HOST_API, name)
}

export function getPluginHostMethodSpec(name: string): PluginHostMethodSpec | null {
  return isPluginHostMethodName(name) ? PLUGIN_HOST_API[name] : null
}

/** The minor this host implements: the newest `since` in the table. */
export const PLUGIN_HOST_API_MINOR = Math.max(
  ...PLUGIN_HOST_METHOD_NAMES.map((name) => PLUGIN_HOST_API[name].since)
)

/** Methods a surface may call, for `hello` and `host.has`. */
export function pluginHostMethodsFor(surface: PluginSurface): PluginHostMethodName[] {
  return PLUGIN_HOST_METHOD_NAMES.filter((name) => PLUGIN_HOST_API[name].surfaces.includes(surface))
}
