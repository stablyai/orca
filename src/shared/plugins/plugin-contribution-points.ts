import { z } from 'zod'
import type { PluginCatalogType } from './catalog/plugin-catalog-release'
import {
  PLUGIN_COMMAND_LIMIT,
  pluginCommandContributionSchema
} from './plugin-command-contribution'
import {
  PLUGIN_AGENT_PROFILE_LIMIT,
  PLUGIN_ICON_THEME_LIMIT,
  PLUGIN_KEYBINDING_LIMIT,
  PLUGIN_LANGUAGE_PACK_LIMIT,
  PLUGIN_SYNTAX_LIMIT,
  PLUGIN_TERMINAL_THEME_LIMIT,
  PLUGIN_THEME_LIMIT,
  PLUGIN_VM_RECIPE_LIMIT,
  pluginAgentProfileContributionSchema,
  pluginKeybindingContributionSchema,
  pluginLanguagePackContributionSchema,
  pluginSyntaxContributionSchema,
  pluginThemeContributionSchema,
  pluginVmRecipeContributionSchema
} from './plugin-content-pack-contributions'
import {
  PLUGIN_EVENT_SUBSCRIPTION_LIMIT,
  pluginEventContributionSchema
} from './plugin-event-contribution'
import type { PluginExecutionProfile } from './plugin-execution-profile'
import { PLUGIN_PANEL_LIMIT, pluginPanelContributionSchema } from './plugin-panel-contribution'
import {
  pluginFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from './manifest/plugin-schema-field-docs'

/** Every `contributes` key, in manifest order. Adding a point starts here. */
export const PLUGIN_CONTRIBUTION_POINTS = [
  'panels',
  'commands',
  'events',
  'languagePacks',
  'keybindings',
  'vmRecipes',
  'agents',
  'themes',
  'terminalThemes',
  'iconThemes',
  'syntaxes'
] as const

export type PluginContributionPoint = (typeof PLUGIN_CONTRIBUTION_POINTS)[number]

/** `contributes` keys held for planned points, so each can ship later as an additive minor
 *  instead of a new manifest format. Each must stay empty until its format is defined. */
export const PLUGIN_RESERVED_CONTRIBUTION_POINTS = {
  skills: 'agent skills',
  mcpServers: 'MCP server definitions',
  taskSources: 'task sources',
  connections: 'account connections',
  settings: 'plugin settings'
} as const

export type PluginReservedContributionPoint = keyof typeof PLUGIN_RESERVED_CONTRIBUTION_POINTS

function reservedList(purpose: string) {
  // Why a refine, not max(0): the issue then carries the reason; maxItems still reaches editors.
  return z
    .array(z.unknown())
    .refine((list) => list.length === 0, `is reserved for ${purpose} and must be empty for now`)
    .optional()
    .meta({
      ...pluginFieldDoc(
        `Reserved for ${purpose}; must be empty until their format is defined.`,
        PLUGIN_MANIFEST_V2_SINCE
      ),
      maxItems: 0
    })
}

function contributionList<Item extends z.ZodType>(
  item: Item,
  limit: number,
  description: string,
  since: string
) {
  return z
    .array(item)
    .max(limit)
    .default([])
    .meta(pluginFieldDoc(`${description} At most ${limit}.`, since))
}

const V1 = PLUGIN_SCHEMA_SINCE_V1
const NEXT = PLUGIN_MANIFEST_V2_SINCE

export const pluginContributesFields = {
  panels: contributionList(
    pluginPanelContributionSchema,
    PLUGIN_PANEL_LIMIT,
    'Sidebar panels.',
    V1
  ),
  commands: contributionList(
    pluginCommandContributionSchema,
    PLUGIN_COMMAND_LIMIT,
    'Command palette entries.',
    V1
  ),
  events: contributionList(
    pluginEventContributionSchema,
    PLUGIN_EVENT_SUBSCRIPTION_LIMIT,
    'Events delivered to the plugin worker.',
    V1
  ),
  languagePacks: contributionList(
    pluginLanguagePackContributionSchema,
    PLUGIN_LANGUAGE_PACK_LIMIT,
    'Interface translations.',
    V1
  ),
  keybindings: contributionList(
    pluginKeybindingContributionSchema,
    PLUGIN_KEYBINDING_LIMIT,
    'Keyboard shortcuts for contributed commands.',
    V1
  ),
  vmRecipes: contributionList(
    pluginVmRecipeContributionSchema,
    PLUGIN_VM_RECIPE_LIMIT,
    'Virtual machine environment recipes.',
    V1
  ),
  agents: contributionList(
    pluginAgentProfileContributionSchema,
    PLUGIN_AGENT_PROFILE_LIMIT,
    'Reserved for coding-agent definitions; must be empty in manifest format 2 until their format is defined.',
    V1
  ),
  themes: contributionList(
    pluginThemeContributionSchema,
    PLUGIN_THEME_LIMIT,
    'App color themes.',
    NEXT
  ),
  terminalThemes: contributionList(
    pluginThemeContributionSchema,
    PLUGIN_TERMINAL_THEME_LIMIT,
    'Terminal ANSI palettes.',
    NEXT
  ),
  iconThemes: contributionList(
    pluginThemeContributionSchema,
    PLUGIN_ICON_THEME_LIMIT,
    'File icon themes.',
    NEXT
  ),
  syntaxes: contributionList(
    pluginSyntaxContributionSchema,
    PLUGIN_SYNTAX_LIMIT,
    'Syntax highlighting for editor languages.',
    NEXT
  )
} satisfies Record<PluginContributionPoint, z.ZodType>

export const pluginReservedContributesFields = {
  skills: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.skills),
  mcpServers: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.mcpServers),
  taskSources: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.taskSources),
  connections: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.connections),
  settings: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.settings)
} satisfies Record<PluginReservedContributionPoint, z.ZodType>

type ContributionPointPolicy = {
  /** Least execution profile allowed to carry a non-empty list of this point. */
  execution: PluginExecutionProfile
  /** Catalog type a release declares for this point; null when `main` already implies it. */
  catalogType: PluginCatalogType | null
}

export const PLUGIN_CONTRIBUTION_POINT_POLICY: Record<
  PluginContributionPoint,
  ContributionPointPolicy
> = {
  panels: { execution: 'sandboxed-ui', catalogType: 'panel' },
  commands: { execution: 'instructional', catalogType: 'instructions' },
  // Why no catalog type: events need a worker, which `main` already declares.
  events: { execution: 'trusted-worker', catalogType: null },
  languagePacks: { execution: 'data', catalogType: 'interface-language' },
  keybindings: { execution: 'instructional', catalogType: 'instructions' },
  vmRecipes: { execution: 'instructional', catalogType: 'instructions' },
  agents: { execution: 'instructional', catalogType: 'instructions' },
  themes: { execution: 'data', catalogType: 'app-theme' },
  terminalThemes: { execution: 'data', catalogType: 'terminal-theme' },
  iconThemes: { execution: 'data', catalogType: 'icon-theme' },
  syntaxes: { execution: 'data', catalogType: 'syntax' }
}
