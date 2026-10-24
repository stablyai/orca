import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from './plugin-engine-floor-keys'
import { pluginFieldDoc, PLUGIN_SCHEMA_SINCE_V1 } from './plugin-schema-field-docs'

/**
 * Plugin capability model v0. The manifest declares capabilities, the user
 * consents against a fingerprint covering capabilities and worker trust, and the
 * host enforces at every plugin-callable boundary (panel bridge + worker host
 * API). Electron-free: shared by desktop main, headless serve, the relay
 * conformance path, and tests.
 *
 * v0 is a closed set of unscoped kinds so a typo (or a capability from a newer
 * Orca) fails manifest validation instead of silently granting nothing.
 * Scoped kinds (net:fetch hosts, process:exec globs) arrive in later phases.
 */

export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own'
] as const

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

/** The release each capability arrived in; engines.orca must cover every one a plugin asks for. */
export const PLUGIN_CAPABILITY_SINCE: Record<PluginCapabilityKind, string> = {
  'workspace:read': PLUGIN_SCHEMA_SINCE_V1,
  'terminal:send': PLUGIN_SCHEMA_SINCE_V1,
  'notifications:show': PLUGIN_SCHEMA_SINCE_V1,
  storage: PLUGIN_SCHEMA_SINCE_V1,
  secrets: PLUGIN_SCHEMA_SINCE_V1,
  'events:subscribe': PLUGIN_SCHEMA_SINCE_V1,
  'settings:own': PLUGIN_SCHEMA_SINCE_V1
}

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

/** Plain-language consent copy per capability. Shown verbatim in the install
 *  preview / consent dialog; keep each line honest about what is enforced. */
export const PLUGIN_CAPABILITY_DESCRIPTIONS: Record<PluginCapabilityKind, string> = {
  'workspace:read': 'Read the name, branch, and terminal list of your focused worktree',
  'terminal:send': 'Type text into a terminal you can see (always a specific terminal)',
  'notifications:show': 'Show desktop notifications labeled with the plugin name',
  storage: "Store data in the plugin's own storage folder",
  secrets: "Store and read secrets in the plugin's own encrypted vault",
  'events:subscribe':
    'Get notified when worktrees are created or removed and when agent status changes',
  'settings:own': "Read and change the plugin's own settings"
}

/**
 * Canonical serialization of a capability set. Order- and duplicate-
 * insensitive so consent is stable across manifest reformatting;
 * key-sorted so future scoped fields cannot produce two encodings of the
 * same grant.
 */
export function canonicalizeCapabilitySet(capabilities: readonly PluginCapability[]): string {
  const encoded = capabilities.map((capability) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(capability).sort(([a], [b]) => a.localeCompare(b)))
    )
  )
  return JSON.stringify([...new Set(encoded)].sort())
}

export function capabilityKinds(capabilities: readonly PluginCapability[]): PluginCapabilityKind[] {
  return [...new Set(capabilities.map((capability) => capability.kind))]
}
