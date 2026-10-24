import { z } from 'zod'
import type { PluginCapabilityKind } from '../plugin-capabilities'

/**
 * Host API 1 (`pluginApi: 1`) — the separately-versioned public facade plugins call. Every
 * method carries params AND result schemas plus capability/mutation metadata;
 * handlers (bound in main) delegate to runtime services. The raw runtime-RPC
 * registry is never exposed: its methods have no result schemas and evolve at
 * internal velocity.
 *
 * This table is the single source of truth for the capability gate, the panel
 * bridge action set, and the worker SDK. Electron-free by design: desktop
 * main, headless serve, the relay conformance path, and tests all import it.
 *
 * Frozen within major 1: additive only. The policy that binds this
 * table is in docs/reference/plugin-host-api.md, generated from it.
 */

export const PANEL_ACTION_TEXT_MAX_LENGTH = 4096
export const PLUGIN_WORKSPACE_TERMINAL_LIMIT = 50
export const PLUGIN_WORKSPACE_LABEL_MAX_LENGTH = 512
export const PLUGIN_TERMINAL_ID_MAX_LENGTH = 1024

const workspaceReadContextParams = z.object({}).strict().optional()
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

const terminalSendTextParams = z.object({
  /** Explicit target. Never "the active terminal": a focus change must not
   *  redirect a delayed plugin write into another pane (design-doc rule). */
  terminalId: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH),
  text: z.string().min(1).max(PANEL_ACTION_TEXT_MAX_LENGTH),
  enter: z.boolean().default(false)
})
const terminalSendTextResult = z.object({ accepted: z.boolean() })

const notificationsShowParams = z.object({
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
/** Caps keep per-plugin storage an honest key-value store, not a database. */
export const PLUGIN_STORAGE_VALUE_MAX_BYTES = 256 * 1024
export const PLUGIN_STORAGE_TOTAL_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_STORAGE_KEY_LIMIT = 1024

const storageGetParams = z.object({ key: storageKeySchema })
const storageGetResult = z.object({ value: pluginJsonValueSchema })
const storageSetParams = z.object({ key: storageKeySchema, value: pluginJsonValueSchema })
const storageSetResult = z.object({ ok: z.literal(true) })
const storageDeleteParams = z.object({ key: storageKeySchema })
const storageDeleteResult = z.object({ ok: z.literal(true) })
const storageKeysParams = z.object({}).strict().optional()
const storageKeysResult = z.object({ keys: z.array(z.string()).max(PLUGIN_STORAGE_KEY_LIMIT) })

const secretsGetParams = z.object({ key: storageKeySchema })
const secretsGetResult = z.object({ value: z.string().nullable() })
const secretsSetParams = z.object({ key: storageKeySchema, value: z.string().max(64 * 1024) })
const secretsSetResult = z.object({ ok: z.literal(true) })
const secretsDeleteParams = z.object({ key: storageKeySchema })
const secretsDeleteResult = z.object({ ok: z.literal(true) })

const settingsGetParams = z.object({}).strict().optional()
const settingsGetResult = z.object({ settings: z.record(z.string(), pluginJsonValueSchema) })
const settingsSetParams = z.object({ key: storageKeySchema, value: pluginJsonValueSchema })
const settingsSetResult = z.object({ ok: z.literal(true) })

export type PluginHostMethodSpec = {
  name: string
  /** One line for the generated reference. */
  summary: string
  /** pluginApi minor the method appeared in (`1.0` for the first set). */
  since: string
  /** pluginApi minor that deprecated it; it keeps working until the next major. */
  deprecatedSince?: string
  /** Machine-readable resource boundary enforced by the host binding. */
  scope: 'active-workspace' | 'explicit-terminal' | 'plugin-private' | 'desktop'
  capability: PluginCapabilityKind
  /** Mutations are audit-logged with actor `plugin:<id>`. */
  mutation: boolean
  /** Whether sandboxed panels may call this over the postMessage bridge.
   *  Workers can call every method. */
  panel: boolean
  params: z.ZodTypeAny
  result: z.ZodTypeAny
}

const spec = <P extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  entry: Omit<PluginHostMethodSpec, 'params' | 'result'> & { params: P; result: R }
): PluginHostMethodSpec => entry

export const PLUGIN_HOST_API: readonly PluginHostMethodSpec[] = [
  spec({
    name: 'workspace.readContext',
    summary:
      'Branch, name and terminal ids of the focused workspace, or null when none is focused.',
    since: '1.0',
    scope: 'active-workspace',
    capability: 'workspace:read',
    mutation: false,
    panel: true,
    params: workspaceReadContextParams,
    result: workspaceReadContextResult
  }),
  spec({
    name: 'terminal.sendText',
    summary: 'Types text into one terminal named by id, optionally pressing Enter.',
    since: '1.0',
    scope: 'explicit-terminal',
    capability: 'terminal:send',
    mutation: true,
    // Why: text plus Enter runs shell commands (local or SSH), so only full-access workers get it.
    panel: false,
    params: terminalSendTextParams,
    result: terminalSendTextResult
  }),
  spec({
    name: 'notifications.show',
    summary: 'Shows a desktop notification.',
    since: '1.0',
    scope: 'desktop',
    capability: 'notifications:show',
    mutation: true,
    panel: true,
    params: notificationsShowParams,
    result: notificationsShowResult
  }),
  spec({
    name: 'storage.get',
    summary: "Reads a JSON value from the plugin's private store; null when absent.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: false,
    panel: false,
    params: storageGetParams,
    result: storageGetResult
  }),
  spec({
    name: 'storage.set',
    summary: "Writes a JSON value to the plugin's private store.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: true,
    panel: false,
    params: storageSetParams,
    result: storageSetResult
  }),
  spec({
    name: 'storage.delete',
    summary: "Removes a key from the plugin's private store.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: true,
    panel: false,
    params: storageDeleteParams,
    result: storageDeleteResult
  }),
  spec({
    name: 'storage.keys',
    summary: "Lists the keys in the plugin's private store.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage:own',
    mutation: false,
    panel: false,
    params: storageKeysParams,
    result: storageKeysResult
  }),
  spec({
    name: 'secrets.get',
    summary: "Reads a secret from the plugin's encrypted secrets file; null when absent.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: false,
    panel: false,
    params: secretsGetParams,
    result: secretsGetResult
  }),
  spec({
    name: 'secrets.set',
    summary: "Stores a secret in the plugin's encrypted secrets file.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: true,
    panel: false,
    params: secretsSetParams,
    result: secretsSetResult
  }),
  spec({
    name: 'secrets.delete',
    summary: "Removes a secret from the plugin's encrypted secrets file.",
    since: '1.0',
    scope: 'plugin-private',
    capability: 'secrets:own',
    mutation: true,
    panel: false,
    params: secretsDeleteParams,
    result: secretsDeleteResult
  }),
  spec({
    name: 'settings.get',
    summary: 'Reads every setting the plugin owns.',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: false,
    panel: false,
    params: settingsGetParams,
    result: settingsGetResult
  }),
  spec({
    name: 'settings.set',
    summary: 'Writes one setting the plugin owns.',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: true,
    panel: false,
    params: settingsSetParams,
    result: settingsSetResult
  })
]

const SPEC_BY_NAME = new Map(PLUGIN_HOST_API.map((entry) => [entry.name, entry]))

export function getPluginHostMethodSpec(name: string): PluginHostMethodSpec | null {
  return SPEC_BY_NAME.get(name) ?? null
}

/** Actions sandboxed panels may request over the postMessage bridge. Derived
 *  from the spec table so the panel surface can never drift from the gate. */
export const PLUGIN_PANEL_ACTIONS = PLUGIN_HOST_API.filter((entry) => entry.panel).map(
  (entry) => entry.name
)

export function isPluginPanelAction(action: string): boolean {
  return PLUGIN_PANEL_ACTIONS.includes(action)
}
