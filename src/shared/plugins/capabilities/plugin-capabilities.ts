import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import {
  pluginFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from '../manifest/plugin-schema-field-docs'

/** Closed v0 capabilities fail unknown kinds instead of silently granting nothing. Consent binds capabilities and worker trust;
 * host boundaries enforce them across desktop, headless serve and relay. Scoped kinds remain future work. */

export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'agent:read',
  'terminal:send',
  'notifications:show',
  'storage:own',
  'secrets:own',
  'settings:own'
] as const

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

/** The release each capability arrived in; engines.orca must cover every one a plugin asks for. */
export const PLUGIN_CAPABILITY_SINCE: Record<PluginCapabilityKind, string> = {
  'workspace:read': PLUGIN_SCHEMA_SINCE_V1,
  'agent:read': PLUGIN_MANIFEST_V2_SINCE,
  'terminal:send': PLUGIN_SCHEMA_SINCE_V1,
  'notifications:show': PLUGIN_SCHEMA_SINCE_V1,
  'storage:own': PLUGIN_MANIFEST_V2_SINCE,
  'secrets:own': PLUGIN_MANIFEST_V2_SINCE,
  'settings:own': PLUGIN_SCHEMA_SINCE_V1
}

/** Format 1 capability names and what each now grants. `events:subscribe` split by event domain. */
export const PLUGIN_V1_CAPABILITY_ALIASES: ReadonlyMap<string, readonly PluginCapabilityKind[]> =
  new Map([
    ['storage', ['storage:own']],
    ['secrets', ['secrets:own']],
    ['events:subscribe', ['workspace:read', 'agent:read']]
  ])

// Strict object (not a bare enum) so scoped fields can be added per-kind later
// without changing the manifest shape.
export const pluginCapabilitySchema = z
  .object({
    kind: z.enum(PLUGIN_CAPABILITY_KINDS).meta({
      ...pluginFieldDoc('Capability granted on user consent.', PLUGIN_SCHEMA_SINCE_V1),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_CAPABILITY_SINCE
    })
  })
  .strict()
  .meta({ id: 'Capability', description: 'A host API the plugin may call once the user consents.' })

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>

/** Consent copy shown verbatim; describe only what the host actually enforces. */
export const PLUGIN_CAPABILITY_DESCRIPTIONS: Record<PluginCapabilityKind, string> = {
  'workspace:read':
    'Read the name, branch, and terminal list of your focused workspace, and get notified when workspaces are created or removed',
  'agent:read': 'Get notified when agent status changes',
  'terminal:send': 'Type and run commands in your terminals, local and SSH',
  'notifications:show': 'Show desktop notifications labeled with the plugin name',
  'storage:own': "Store data in the plugin's own storage folder",
  'secrets:own': "Store and read secrets in the plugin's own encrypted file",
  'settings:own': "Read and change the plugin's own settings"
}

/** Canonicalize order, duplicates and field order so equivalent grants preserve consent across manifest formatting changes. */
export function canonicalizeCapabilitySet(capabilities: readonly PluginCapability[]): string {
  return JSON.stringify([...new Set(capabilities.map(canonicalizeCapability))].sort())
}

/** One grant, key-sorted, so a scoped field such as hosts counts as part of what is granted. */
export function canonicalizeCapability(capability: PluginCapability): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(capability).sort(([a], [b]) => a.localeCompare(b)))
  )
}

export function capabilityKinds(capabilities: readonly PluginCapability[]): PluginCapabilityKind[] {
  return [...new Set(capabilities.map((capability) => capability.kind))]
}
