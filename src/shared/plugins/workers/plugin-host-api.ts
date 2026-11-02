import { z } from 'zod'
import type { PluginSurface } from '../frames/plugin-protocol'
import * as stored from './plugin-host-api-storage-schemas'
import { PLUGIN_PANEL_BRIDGE_API } from './plugin-host-api-panel-methods'
import {
  ALL_SURFACES,
  FRAMES_ONLY,
  pluginHostMethodSinceFor,
  spec,
  WORKER_ONLY,
  type PluginHostMethodSpec
} from './plugin-host-method-spec'

export type { PluginHostMethodSpec } from './plugin-host-method-spec'

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
/** What `workspace.readContext` answers and `workspace.changed` carries. */
export const pluginWorkspaceContextSchema = z
  .object({
    branch: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    displayName: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    /** Terminals of the focused workspace, so callers can address a specific
     *  terminal id — the API has no "active terminal" write target. */
    terminals: z
      .array(
        z
          .object({
            id: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH),
            /** The pane's name, or its terminal title; absent when it has neither. */
            title: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH).optional()
          })
          .strict()
      )
      .max(PLUGIN_WORKSPACE_TERMINAL_LIMIT)
  })
  .strict()
  .nullable()
const workspaceReadContextResult = pluginWorkspaceContextSchema

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

export {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES,
  PLUGIN_STORAGE_VALUE_MAX_BYTES,
  type PluginJsonValue
} from './plugin-host-api-storage-schemas'

/** Frame methods that only run on a click or key press in the frame (`userActivation`). */
export const PLUGIN_FRAME_USER_METHODS = {
  openExternal: 'shell.openExternal',
  saveAs: 'files.saveAs'
} as const

export const PLUGIN_EXTERNAL_URL_MAX_LENGTH = 8192
export const PLUGIN_EXTERNAL_URL_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:']
export const PLUGIN_SAVE_AS_MAX_BYTES = 64 * 1024 * 1024

const shellOpenExternalParams = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(PLUGIN_EXTERNAL_URL_MAX_LENGTH)
    .refine(isPluginExternalUrl, 'url must be an http:, https: or mailto: URL')
})
/** `reason`, when not opened: the person said no, or nobody could be asked (Orca's window hidden). */
const shellOpenExternalResult = z.object({
  opened: z.boolean(),
  reason: z.enum(['cancelled', 'consent-unavailable']).optional()
})

const saveAsDataSchema = z.union([
  z.string().max(PLUGIN_SAVE_AS_MAX_BYTES),
  // Why Uint8Array too: IPC between Orca's own processes may hand bytes over as a view.
  z
    .custom<ArrayBuffer | Uint8Array>(
      (value) => value instanceof ArrayBuffer || value instanceof Uint8Array,
      'data must be a string or ArrayBuffer'
    )
    .refine((value) => value.byteLength <= PLUGIN_SAVE_AS_MAX_BYTES, 'data exceeds 64 MiB')
    // Names the type in the generated reference, which otherwise prints unrepresentable as JSON.
    .meta({ type: 'ArrayBuffer' })
])
const filesSaveAsParams = z.strictObject({
  suggestedName: z.string().min(1).max(255).optional(),
  mimeType: z.string().min(1).max(255).optional(),
  data: saveAsDataSchema
})
/** The chosen path never reaches the plugin; a cancelled dialog is a result, not an error. */
const filesSaveAsResult = z.object({ status: z.enum(['saved', 'cancelled']) })

export function isPluginExternalUrl(url: string): boolean {
  try {
    return PLUGIN_EXTERNAL_URL_PROTOCOLS.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

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
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.storageGetParams,
    result: stored.storageGetResult
  }),
  'storage.set': spec({
    summary: "Writes a JSON value to the plugin's private store.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: true,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.storageSetParams,
    result: stored.storageSetResult
  }),
  'storage.delete': spec({
    summary: "Removes a key from the plugin's private store.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: true,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.storageDeleteParams,
    result: stored.storageDeleteResult
  }),
  'storage.keys': spec({
    summary: "Lists the keys in the plugin's private store.",
    since: 0,
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: false,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.storageKeysParams,
    result: stored.storageKeysResult
  }),
  'secrets.get': spec({
    summary: "Reads a secret from the plugin's encrypted secrets file; null when absent.",
    since: 0,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: false,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.secretsGetParams,
    result: stored.secretsGetResult
  }),
  'secrets.set': spec({
    summary: "Stores a secret in the plugin's encrypted secrets file.",
    since: 0,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: true,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.secretsSetParams,
    result: stored.secretsSetResult
  }),
  'secrets.delete': spec({
    summary: "Removes a secret from the plugin's encrypted secrets file.",
    since: 0,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: true,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.secretsDeleteParams,
    result: stored.secretsDeleteResult
  }),
  'secrets.protection': spec({
    summary:
      'How secrets are protected at rest: `os-keyring`, or `unavailable` (no OS key store, or Linux `basic_text`), where `secrets.set` fails.',
    since: 1,
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: false,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.secretsProtectionParams,
    result: stored.secretsProtectionResult
  }),
  'settings.get': spec({
    summary: 'Reads every setting the plugin owns.',
    since: 0,
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: false,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.settingsGetParams,
    result: stored.settingsGetResult
  }),
  'settings.set': spec({
    summary: 'Writes one setting the plugin owns.',
    since: 0,
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: true,
    framesSince: 2,
    surfaces: ALL_SURFACES,
    params: stored.settingsSetParams,
    result: stored.settingsSetResult
  }),
  'shell.openExternal': spec({
    summary:
      'Opens an http:, https: or mailto: URL in the default browser. Needs a click or key press in the frame; desktop app only. Orca asks the person before an http(s) host the plugin was not allowed; `opened` is false if they cancel.',
    since: 1,
    scope: 'desktop',
    capability: null,
    userActivation: true,
    mutation: false,
    surfaces: FRAMES_ONLY,
    params: shellOpenExternalParams,
    result: shellOpenExternalResult
  }),
  'files.saveAs': spec({
    summary:
      "Offers data (a string or ArrayBuffer, up to 64 MiB) in Orca's save dialog; the plugin never learns the path. Needs a click or key press in the frame; desktop app only.",
    since: 1,
    scope: 'desktop',
    capability: null,
    userActivation: true,
    mutation: true,
    surfaces: FRAMES_ONLY,
    params: filesSaveAsParams,
    result: filesSaveAsResult
  }),
  ...PLUGIN_PANEL_BRIDGE_API
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

/** A frame's methods: user-gesture methods only where Orca can verify the gesture (a guest). */
export function pluginFrameMethodsFor(
  surface: 'panel' | 'editor',
  isolatedGuest: boolean
): PluginHostMethodName[] {
  return pluginHostMethodsFor(surface).filter(
    (name) => isolatedGuest || PLUGIN_HOST_API[name].userActivation !== true
  )
}

/** The minor a frame reports: the newest method it is actually offered, so iframes stay at 0. */
export function pluginHostApiMinorFor(
  methods: readonly PluginHostMethodName[],
  surface: PluginSurface = 'panel'
): number {
  return Math.max(
    0,
    ...methods.map((name) => pluginHostMethodSinceFor(PLUGIN_HOST_API[name], surface))
  )
}
