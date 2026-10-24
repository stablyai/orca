import { z } from 'zod'
import type { PluginCatalogType } from './catalog/plugin-catalog-types'
import {
  PLUGIN_COMMAND_LIMIT,
  pluginCommandContributionSchema
} from './plugin-command-contribution'
import {
  PLUGIN_ICON_THEME_LIMIT,
  PLUGIN_KEYBINDING_LIMIT,
  PLUGIN_LANGUAGE_PACK_LIMIT,
  PLUGIN_SYNTAX_LIMIT,
  PLUGIN_TERMINAL_THEME_LIMIT,
  PLUGIN_THEME_LIMIT,
  PLUGIN_VM_RECIPE_LIMIT,
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
  'themes',
  'terminalThemes',
  'iconThemes',
  'syntaxes'
] as const

export type PluginContributionPoint = (typeof PLUGIN_CONTRIBUTION_POINTS)[number]

/** `contributes` keys held for planned points, so each can ship later as an additive minor
 *  instead of a new manifest format. Each must stay empty until its format is defined. */
export const PLUGIN_RESERVED_CONTRIBUTION_POINTS = {
  agents: 'coding-agent definitions',
  skills: 'agent skills',
  mcpServers: 'MCP server definitions',
  taskSources: 'task sources',
  connections: 'account connections',
  settings: 'plugin settings',
  statusBarItems: 'status bar items',
  sidebarCards: 'sidebar cards'
} as const

export type PluginReservedContributionPoint = keyof typeof PLUGIN_RESERVED_CONTRIBUTION_POINTS

/** The intended shape of each reserved point, in the order the references list them. */
export const PLUGIN_PLANNED_CONTRIBUTION_POINTS: Readonly<
  Record<PluginReservedContributionPoint, string>
> = {
  taskSources:
    'Issue and task providers such as Asana, Linear or Jira, declared as data that a worker fills with tasks.',
  connections:
    'Account providers with a host-run sign-in, so a plugin never handles credentials itself.',
  agents: 'New coding-agent harnesses described as data: how to launch them and read their status.',
  statusBarItems:
    'Declarative status bar widgets (label, icon, tooltip) whose values a worker updates.',
  sidebarCards: 'Declarative left-sidebar cards with fixed layouts whose values a worker updates.',
  mcpServers: 'MCP server definitions that Orca offers to the agents it launches.',
  skills: 'Agent skills shipped as files that Orca installs for the agents it launches.',
  settings: 'Typed plugin settings that Orca renders in its own settings UI.'
}

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
  agents: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.agents),
  skills: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.skills),
  mcpServers: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.mcpServers),
  taskSources: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.taskSources),
  connections: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.connections),
  settings: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.settings),
  statusBarItems: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.statusBarItems),
  sidebarCards: reservedList(PLUGIN_RESERVED_CONTRIBUTION_POINTS.sidebarCards)
} satisfies Record<PluginReservedContributionPoint, z.ZodType>

type ContributionPointPolicy = {
  /** Least execution profile allowed to carry a non-empty list of this point. */
  execution: PluginExecutionProfile
  /** Catalog type a release declares for this point; null when `main` already implies it. */
  catalogType: PluginCatalogType | null
  /** Its bytes act later under user or agent authority, so approval names the exact content.
   *  Executable points (panels, events) are bound by their execution profile instead. */
  bindsContent: boolean
}

export const PLUGIN_CONTRIBUTION_POINT_POLICY: Record<
  PluginContributionPoint,
  ContributionPointPolicy
> = {
  panels: { execution: 'sandboxed-ui', catalogType: 'panel', bindsContent: false },
  // Why unbound: an alias command only names a built-in action; it carries no bytes.
  commands: { execution: 'declarative', catalogType: 'instructions', bindsContent: false },
  // Why no catalog type: events need a worker, which `main` already declares.
  events: { execution: 'trusted-worker', catalogType: null, bindsContent: false },
  languagePacks: { execution: 'data', catalogType: 'interface-language', bindsContent: false },
  keybindings: { execution: 'declarative', catalogType: 'instructions', bindsContent: true },
  vmRecipes: { execution: 'declarative', catalogType: 'instructions', bindsContent: true },
  themes: { execution: 'data', catalogType: 'app-theme', bindsContent: false },
  terminalThemes: { execution: 'data', catalogType: 'terminal-theme', bindsContent: false },
  iconThemes: { execution: 'data', catalogType: 'icon-theme', bindsContent: false },
  syntaxes: { execution: 'data', catalogType: 'syntax', bindsContent: false }
}
