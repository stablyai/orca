import { z } from 'zod'
import { pluginFocusedSurfaceSchema } from './plugin-focused-surface'
import { PLUGIN_EVENT_NAMES } from './plugin-manifest'
import type { PluginCapabilityKind } from './plugin-capabilities'
import {
  sidecarPlacementSchema,
  sidecarPublishParamsSchema,
  sidecarPublishResultSchema
} from './plugin-sidecar-contract'

/**
 * Host API v0 — the separately-versioned public facade plugins call. Every
 * method carries params AND result schemas plus capability/mutation metadata;
 * handlers (bound in main) delegate to runtime services. The raw runtime-RPC
 * registry is never exposed: its methods have no result schemas and evolve at
 * internal velocity.
 *
 * This table is the single source of truth for the capability gate, the panel
 * bridge action set, and the worker SDK. Electron-free by design: desktop
 * main, headless serve, the relay conformance path, and tests all import it.
 *
 * EXPERIMENTAL: additive-only within pluginApi major 1 once frozen; no
 * stability promises before then.
 */

export const PANEL_ACTION_TEXT_MAX_LENGTH = 4096
export const PLUGIN_WORKSPACE_TERMINAL_LIMIT = 50
export const PLUGIN_WORKSPACE_LABEL_MAX_LENGTH = 512
export const PLUGIN_TERMINAL_ID_MAX_LENGTH = 1024
export const PLUGIN_AGENT_TYPE_MAX_LENGTH = 40
export const PLUGIN_AGENT_MODEL_MAX_LENGTH = 120
export const PLUGIN_AGENT_PROFILE_MAX_LENGTH = 80

export const pluginWorkspaceExecutionHostSchema = z
  .object({
    kind: z.enum(['local', 'ssh', 'runtime']),
    label: z.string().min(1).max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH)
  })
  .strict()

export const pluginWorkspaceAgentContextSchema = z
  .object({
    type: z.string().min(1).max(PLUGIN_AGENT_TYPE_MAX_LENGTH).nullable().optional(),
    model: z.string().min(1).max(PLUGIN_AGENT_MODEL_MAX_LENGTH).nullable().optional(),
    profile: z.string().min(1).max(PLUGIN_AGENT_PROFILE_MAX_LENGTH).nullable().optional()
  })
  .strict()

const workspaceReadContextParams = z.object({}).strict().optional()
const workspaceReadContextResult = z
  .object({
    branch: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    displayName: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    /** Terminals of the focused worktree, so callers can address a specific
     *  terminal id — the API has no "active terminal" write target. */
    terminals: z
      .array(
        z
          .object({
            id: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH)
          })
          .strict()
      )
      .max(PLUGIN_WORKSPACE_TERMINAL_LIMIT),
    /** Execution host of the focused worktree. Labels only — never hostname. */
    executionHost: pluginWorkspaceExecutionHostSchema.nullable().optional(),
    /** Agent type / model / Orca profile labels when the host already knows them. */
    agent: pluginWorkspaceAgentContextSchema.nullable().optional(),
    /** Present only for plugins that declared `ui:focus`. Null when unknown. */
    focusedSurface: pluginFocusedSurfaceSchema.nullable().optional()
  })
  .strict()
  .nullable()

export type PluginWorkspaceExecutionHost = z.infer<typeof pluginWorkspaceExecutionHostSchema>
export type PluginWorkspaceAgentContext = z.infer<typeof pluginWorkspaceAgentContextSchema>

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

const eventsSubscribeParams = z.object({
  events: z.array(z.enum(PLUGIN_EVENT_NAMES)).min(1).max(PLUGIN_EVENT_NAMES.length)
})
const eventsSubscribeResult = z.object({ subscribed: z.array(z.enum(PLUGIN_EVENT_NAMES)) })

export type PluginHostMethodSpec = {
  name: string
  /** pluginApi minor the method appeared in (`1.0` for the v0 set). */
  since: string
  /** Machine-readable resource boundary enforced by the host binding. */
  scope:
    | 'active-worktree'
    | 'explicit-terminal'
    | 'plugin-private'
    | 'desktop'
    | 'host-events'
    | 'sidecar'
    | 'ui-focus'
  stability: 'experimental'
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
  entry: Omit<PluginHostMethodSpec, 'params' | 'result' | 'stability'> & {
    params: P
    result: R
  }
): PluginHostMethodSpec => ({ ...entry, stability: 'experimental' })

export const PLUGIN_HOST_API_V0: readonly PluginHostMethodSpec[] = [
  spec({
    name: 'workspace.readContext',
    since: '1.0',
    scope: 'active-worktree',
    capability: 'workspace:read',
    mutation: false,
    panel: true,
    params: workspaceReadContextParams,
    result: workspaceReadContextResult
  }),
  spec({
    name: 'terminal.sendText',
    since: '1.0',
    scope: 'explicit-terminal',
    capability: 'terminal:send',
    mutation: true,
    panel: true,
    params: terminalSendTextParams,
    result: terminalSendTextResult
  }),
  spec({
    name: 'notifications.show',
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
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage',
    mutation: false,
    // Session-bound own store; panel payloads still cap at PANEL_MESSAGE_MAX_BYTES.
    panel: true,
    params: storageGetParams,
    result: storageGetResult
  }),
  spec({
    name: 'storage.set',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage',
    mutation: true,
    panel: true,
    params: storageSetParams,
    result: storageSetResult
  }),
  spec({
    name: 'storage.delete',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage',
    mutation: true,
    panel: true,
    params: storageDeleteParams,
    result: storageDeleteResult
  }),
  spec({
    name: 'storage.keys',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'storage',
    mutation: false,
    panel: true,
    params: storageKeysParams,
    result: storageKeysResult
  }),
  spec({
    name: 'secrets.get',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'secrets',
    mutation: false,
    panel: false,
    params: secretsGetParams,
    result: secretsGetResult
  }),
  spec({
    name: 'secrets.set',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'secrets',
    mutation: true,
    panel: false,
    params: secretsSetParams,
    result: secretsSetResult
  }),
  spec({
    name: 'secrets.delete',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'secrets',
    mutation: true,
    panel: false,
    params: secretsDeleteParams,
    result: secretsDeleteResult
  }),
  spec({
    name: 'settings.get',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: false,
    // Why: panels need a settings screen; identity is session-bound, never caller-supplied.
    panel: true,
    params: settingsGetParams,
    result: settingsGetResult
  }),
  spec({
    name: 'settings.set',
    since: '1.0',
    scope: 'plugin-private',
    capability: 'settings:own',
    mutation: true,
    panel: true,
    params: settingsSetParams,
    result: settingsSetResult
  }),
  spec({
    name: 'events.subscribe',
    since: '1.0',
    scope: 'host-events',
    capability: 'events:subscribe',
    mutation: false,
    panel: false,
    params: eventsSubscribeParams,
    result: eventsSubscribeResult
  }),
  spec({
    name: 'sidecar.resolvePlacement',
    since: '1.1',
    scope: 'sidecar',
    capability: 'sidecar',
    mutation: false,
    panel: false,
    params: z.object({}).strict().optional(),
    result: sidecarPlacementSchema
  }),
  spec({
    name: 'sidecar.publish',
    since: '1.1',
    scope: 'sidecar',
    capability: 'sidecar',
    mutation: true,
    panel: false,
    params: sidecarPublishParamsSchema,
    result: sidecarPublishResultSchema
  }),
  spec({
    name: 'ui.readFocus',
    since: '1.2',
    scope: 'ui-focus',
    capability: 'ui:focus',
    mutation: false,
    panel: true,
    params: z.object({}).strict().optional(),
    result: z
      .object({
        focusedSurface: pluginFocusedSurfaceSchema.nullable()
      })
      .strict()
  })
]

const SPEC_BY_NAME = new Map(PLUGIN_HOST_API_V0.map((entry) => [entry.name, entry]))

export function getPluginHostMethodSpec(name: string): PluginHostMethodSpec | null {
  return SPEC_BY_NAME.get(name) ?? null
}

/** Actions sandboxed panels may request over the postMessage bridge. Derived
 *  from the spec table so the panel surface can never drift from the gate. */
export const PLUGIN_PANEL_ACTIONS = PLUGIN_HOST_API_V0.filter((entry) => entry.panel).map(
  (entry) => entry.name
)

export function isPluginPanelAction(action: string): boolean {
  return PLUGIN_PANEL_ACTIONS.includes(action)
}
