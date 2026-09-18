import { z } from 'zod'
import { pluginCapabilityPathsSchema } from './plugin-capability-scope'

/**
 * Plugin capability model v0. The manifest declares capabilities, the user
 * consents against a fingerprint covering capabilities and worker trust, and the
 * host enforces at every plugin-callable boundary (panel bridge + worker host
 * API). Electron-free: shared by desktop main, headless serve, the relay
 * conformance path, and tests.
 *
 * The kind set is closed so a typo (or a capability from a newer Orca) fails
 * manifest validation instead of silently granting nothing. Most kinds are
 * unscoped; `files:read` carries the globs it is granted over.
 */

export const PLUGIN_UNSCOPED_CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own',
  'workspace:list'
] as const

export const PLUGIN_SCOPED_CAPABILITY_KINDS = ['files:read'] as const

// Derived rather than written out flat so the kinds are spelled exactly once.
export const PLUGIN_CAPABILITY_KINDS = [
  ...PLUGIN_UNSCOPED_CAPABILITY_KINDS,
  ...PLUGIN_SCOPED_CAPABILITY_KINDS
] as const

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

// Why `kind` is the only key here, strictly: the parsed object for an unscoped kind
// must carry nothing else, or its canonical encoding moves. A shared scope field
// with a default on the common schema would materialise a second key on every kind,
// change all seven pre-existing encodings, and drop every installed plugin to
// pending re-approval with no error raised.
export const unscopedPluginCapabilitySchema = z
  .object({ kind: z.enum(PLUGIN_UNSCOPED_CAPABILITY_KINDS) })
  .strict()

export const scopedFilesReadCapabilitySchema = z
  .object({ kind: z.literal('files:read'), paths: pluginCapabilityPathsSchema })
  .strict()

export const pluginCapabilitySchema = z.discriminatedUnion('kind', [
  unscopedPluginCapabilitySchema,
  scopedFilesReadCapabilitySchema
])

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
  'settings:own': "Read and change the plugin's own settings",
  'workspace:list': 'Read the name, branch, and host of all your worktrees',
  'files:read': 'Read files inside your worktrees that match the file patterns this plugin declares'
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
