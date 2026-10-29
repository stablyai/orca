import { z } from 'zod'

/** Closed v0 capabilities fail unknown kinds instead of silently granting nothing. Consent binds capabilities and worker trust;
 * host boundaries enforce them across desktop, headless serve and relay. Scoped kinds remain future work. */

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

// Object shape permits future per-kind scopes without changing manifest structure.
export const pluginCapabilitySchema = z.object({ kind: z.enum(PLUGIN_CAPABILITY_KINDS) }).strict()

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>

/** Consent copy shown verbatim; describe only what the host actually enforces. */
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

/** Canonicalize order, duplicates and field order so equivalent grants preserve consent across manifest formatting changes. */
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
