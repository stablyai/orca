import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from './manifest/plugin-engine-floor-keys'
import {
  pluginFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from './manifest/plugin-schema-field-docs'
import type { PluginCapabilityKind } from './plugin-capabilities'

/** Domain events a plugin can subscribe to in v0. Closed set: server-side
 *  filtering means plugins only ever receive what they subscribed to. */
export const PLUGIN_EVENT_NAMES = [
  'workspace.created',
  'workspace.removed',
  'agent.status.changed'
] as const
export const PLUGIN_EVENT_SUBSCRIPTION_LIMIT = PLUGIN_EVENT_NAMES.length

export type PluginEventName = (typeof PLUGIN_EVENT_NAMES)[number]

/** The release each event arrived in; engines.orca must cover every one a plugin subscribes to. */
export const PLUGIN_EVENT_SINCE: Record<PluginEventName, string> = {
  'workspace.created': PLUGIN_MANIFEST_V2_SINCE,
  'workspace.removed': PLUGIN_MANIFEST_V2_SINCE,
  'agent.status.changed': PLUGIN_SCHEMA_SINCE_V1
}

/** Format 1 event names, rewritten on parse and still dispatched to handlers registered under them. */
export const PLUGIN_V1_EVENT_ALIASES: ReadonlyMap<string, PluginEventName> = new Map([
  ['worktree.created', 'workspace.created'],
  ['worktree.removed', 'workspace.removed']
])

/** Each event is gated by the read capability of its domain, never a blanket event grant. */
export const PLUGIN_EVENT_CAPABILITY: Record<PluginEventName, PluginCapabilityKind> = {
  'workspace.created': 'workspace:read',
  'workspace.removed': 'workspace:read',
  'agent.status.changed': 'agents:read'
}

export const pluginEventContributionSchema = z
  .object({
    on: z.enum(PLUGIN_EVENT_NAMES).meta({
      ...pluginFieldDoc('Event delivered to the plugin worker.', PLUGIN_SCHEMA_SINCE_V1),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_EVENT_SINCE
    })
  })
  .strict()
  .meta({
    id: 'EventContribution',
    description:
      "An event subscription. Requires `main`, the `trusted-worker` execution profile and the capability of the event's domain: `workspace:read` for workspace events, `agents:read` for agent events."
  })

export type PluginEventContribution = z.infer<typeof pluginEventContributionSchema>
