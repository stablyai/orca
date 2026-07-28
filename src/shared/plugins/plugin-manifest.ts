import { z } from 'zod'
import { pluginCapabilitySchema } from './plugin-capabilities'
import {
  PLUGIN_AGENT_PROFILE_LIMIT,
  PLUGIN_ICON_THEME_LIMIT,
  PLUGIN_KEYBINDING_LIMIT,
  PLUGIN_LANGUAGE_PACK_LIMIT,
  PLUGIN_THEME_LIMIT,
  PLUGIN_TERMINAL_THEME_LIMIT,
  PLUGIN_VM_RECIPE_LIMIT,
  pluginAgentProfileContributionSchema,
  pluginIconThemeContributionSchema,
  pluginKeybindingContributionSchema,
  pluginLanguagePackContributionSchema,
  pluginThemeContributionSchema,
  pluginTerminalThemeContributionSchema,
  pluginVmRecipeContributionSchema
} from './plugin-content-pack-contributions'
import {
  isPluginManifestId,
  isSafePluginId,
  pluginCommandIdSchema,
  pluginIdSchema,
  pluginRelativePathSchema
} from './plugin-manifest-fields'
import { validatePluginManifestContributions } from './plugin-manifest-contribution-validation'

/**
 * Plugin manifest v1 (`orca-plugin.json` at the plugin root). The
 * `contributes` key names deliberately mirror common Electron-ecosystem
 * manifest conventions so future adapters stay cheap.
 *
 * Lives in `shared` so the desktop app, the headless `orca serve` runtime,
 * the relay, and the CLI validate manifests identically (SSH/remote parity).
 *
 * Everything here is EXPERIMENTAL: no compatibility promises until pluginApi
 * v1 freezes (see the plugin roadmap).
 */

const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const PLUGIN_PANEL_LIMIT = 64
export const PLUGIN_COMMAND_LIMIT = 256

// Why: v0 supports only the ">=x.y.z" form. A closed grammar keeps the gate
// predictable; richer ranges can be added without breaking old manifests.
const orcaEngineRangeSchema = z
  .string()
  .max(64)
  .regex(/^>=\d+\.\d+\.\d+$/, 'must be a ">=x.y.z" version range')

const panelContributionSchema = z.object({
  id: pluginIdSchema,
  title: z.string().min(1).max(256),
  /** Lucide icon name rendered in the right-sidebar activity bar. */
  icon: z.string().min(1).max(64).optional(),
  /** HTML entry rendered inside a sandboxed panel frame. */
  entry: pluginRelativePathSchema
})

const commandContributionSchema = z.object({
  id: pluginCommandIdSchema,
  title: z.string().min(1).max(256),
  context: z.enum(['global', 'worktree']).optional(),
  /** Built-in action aliases remain declarative and do not activate a worker. */
  action: pluginCommandIdSchema.optional()
})

/** Domain events a plugin can subscribe to in v0. Closed set: server-side
 *  filtering means plugins only ever receive what they subscribed to. */
export const PLUGIN_EVENT_NAMES = [
  'worktree.created',
  'worktree.removed',
  'agent.status.changed'
] as const
export const PLUGIN_EVENT_SUBSCRIPTION_LIMIT = PLUGIN_EVENT_NAMES.length

export type PluginEventName = (typeof PLUGIN_EVENT_NAMES)[number]

const eventContributionSchema = z.object({
  on: z.enum(PLUGIN_EVENT_NAMES)
})

export const pluginManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: pluginIdSchema,
    /** Publisher slug; canonical identity is `<publisher>.<id>` — bare-id
     *  global uniqueness is unverifiable without a registry. */
    publisher: pluginIdSchema,
    name: z.string().min(1).max(256),
    version: z.string().regex(SEMVER_RE, 'must be semver'),
    description: z.string().max(4096).optional(),
    author: z
      .object({ name: z.string().min(1).max(256), url: z.string().max(2048).optional() })
      .optional(),
    repository: z.string().max(2048).optional(),
    icon: pluginRelativePathSchema.optional(),
    /** Minimum host version gate; the host refuses to load below it. */
    engines: z.object({ orca: orcaEngineRangeSchema }),
    /** Host-API major version this plugin targets. */
    pluginApi: z.literal(1),
    /** Node entry executed inside the out-of-process plugin worker. */
    main: pluginRelativePathSchema.optional(),
    contributes: z
      .object({
        panels: z.array(panelContributionSchema).max(PLUGIN_PANEL_LIMIT).default([]),
        commands: z.array(commandContributionSchema).max(PLUGIN_COMMAND_LIMIT).default([]),
        events: z.array(eventContributionSchema).max(PLUGIN_EVENT_SUBSCRIPTION_LIMIT).default([]),
        themes: z.array(pluginThemeContributionSchema).max(PLUGIN_THEME_LIMIT).default([]),
        iconThemes: z
          .array(pluginIconThemeContributionSchema)
          .max(PLUGIN_ICON_THEME_LIMIT)
          .default([]),
        terminalThemes: z
          .array(pluginTerminalThemeContributionSchema)
          .max(PLUGIN_TERMINAL_THEME_LIMIT)
          .default([]),
        languagePacks: z
          .array(pluginLanguagePackContributionSchema)
          .max(PLUGIN_LANGUAGE_PACK_LIMIT)
          .default([]),
        keybindings: z
          .array(pluginKeybindingContributionSchema)
          .max(PLUGIN_KEYBINDING_LIMIT)
          .default([]),
        vmRecipes: z
          .array(pluginVmRecipeContributionSchema)
          .max(PLUGIN_VM_RECIPE_LIMIT)
          .default([]),
        agents: z
          .array(pluginAgentProfileContributionSchema)
          .max(PLUGIN_AGENT_PROFILE_LIMIT)
          .default([])
      })
      .strict()
      .default(() => ({
        panels: [],
        commands: [],
        events: [],
        themes: [],
        iconThemes: [],
        terminalThemes: [],
        languagePacks: [],
        keybindings: [],
        vmRecipes: [],
        agents: []
      })),
    capabilities: z.array(pluginCapabilitySchema).max(32).default([])
  })
  .superRefine(validatePluginManifestContributions)

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginPanelContribution = z.infer<typeof panelContributionSchema>
export type PluginCommandContribution = z.infer<typeof commandContributionSchema>
export type PluginEventContribution = z.infer<typeof eventContributionSchema>

export {
  isSafePluginId,
  PLUGIN_ID_MAX_LENGTH,
  pluginCommandIdSchema
} from './plugin-manifest-fields'

export const PLUGIN_MANIFEST_FILENAME = 'orca-plugin.json'

/** Canonical install identity: `<publisher>.<id>` (also the install dir name). */
export function qualifiedPluginKey(manifest: Pick<PluginManifest, 'publisher' | 'id'>): string {
  return `${manifest.publisher}.${manifest.id}`
}

export function isQualifiedPluginKey(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 2) {
    return false
  }
  return isSafePluginId(parts[0]!) && isSafePluginId(parts[1]!)
}

export type PluginManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string }

export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const parsed = pluginManifestSchema.safeParse(raw)
  if (parsed.success) {
    return { ok: true, manifest: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid manifest'}` }
}

/** v0 engines gate: supports the ">=x.y.z" grammar the schema enforces.
 *  Prerelease/build suffixes on the host version are ignored for ordering. */
export function satisfiesOrcaEngineRange(hostVersion: string, range: string): boolean {
  const minimum = range.slice(2)
  const parse = (value: string): number[] =>
    value
      .split(/[-+]/)[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const host = parse(hostVersion)
  const min = parse(minimum)
  for (let i = 0; i < 3; i++) {
    const a = host[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return true
}

/** Sidebar tab key for a plugin panel: `plugin:<publisher>.<id>/<panelId>`. */
export function pluginPanelTabKey(qualifiedKey: string, panelId: string): `plugin:${string}` {
  return `plugin:${qualifiedKey}/${panelId}`
}

export function isPluginPanelTabKey(tab: string): tab is `plugin:${string}` {
  if (!tab.startsWith('plugin:')) {
    return false
  }
  const rest = tab.slice('plugin:'.length)
  const [qualifiedKey, panelId, ...extra] = rest.split('/')
  return (
    extra.length === 0 &&
    !!qualifiedKey &&
    !!panelId &&
    isQualifiedPluginKey(qualifiedKey) &&
    isPluginManifestId(panelId)
  )
}
