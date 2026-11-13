import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import { PLUGIN_APPEARANCE_SINCE } from '../workers/plugin-host-api-appearance'
import { PLUGIN_HOST_API_1_8_SINCE } from '../workers/plugin-host-api-1-8'
import { PLUGIN_HOST_API_1_9_SINCE } from '../workers/plugin-host-api-1-9'
import {
  pluginFieldDoc,
  PLUGIN_HOST_ACTIONS_SINCE,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from '../manifest/plugin-schema-field-docs'

/** Closed v0 capabilities fail unknown kinds instead of silently granting nothing. Consent binds capabilities and worker trust;
 * host boundaries enforce them across desktop, headless serve and relay. Scoped kinds remain future work. */

export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'workspace:write',
  'agent:read',
  'agent:launch',
  'terminal:send',
  'terminal:read',
  'notifications:show',
  'storage:own',
  'secrets:own',
  'settings:own',
  'appearance:write',
  'workspace:create',
  'automation:read',
  'automation:write',
  'history:read'
] as const

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

/** The release each capability arrived in; engines.orca must cover every one a plugin asks for. */
export const PLUGIN_CAPABILITY_SINCE: Record<PluginCapabilityKind, string> = {
  'workspace:read': PLUGIN_SCHEMA_SINCE_V1,
  'workspace:write': PLUGIN_HOST_ACTIONS_SINCE,
  'agent:read': PLUGIN_MANIFEST_V2_SINCE,
  'agent:launch': PLUGIN_HOST_ACTIONS_SINCE,
  'terminal:send': PLUGIN_SCHEMA_SINCE_V1,
  'terminal:read': PLUGIN_HOST_ACTIONS_SINCE,
  'notifications:show': PLUGIN_SCHEMA_SINCE_V1,
  'storage:own': PLUGIN_MANIFEST_V2_SINCE,
  'secrets:own': PLUGIN_MANIFEST_V2_SINCE,
  'settings:own': PLUGIN_SCHEMA_SINCE_V1,
  'appearance:write': PLUGIN_APPEARANCE_SINCE,
  'workspace:create': PLUGIN_HOST_API_1_8_SINCE,
  'automation:read': PLUGIN_HOST_API_1_8_SINCE,
  'automation:write': PLUGIN_HOST_API_1_8_SINCE,
  'history:read': PLUGIN_HOST_API_1_9_SINCE
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
    'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change',
  'workspace:write':
    'Open and rename your workspaces, hide projects from the sidebar or show them again, focus their terminals, open their files in Orca, and run its built-in commands',
  'agent:read': 'Get notified when agent status changes',
  'agent:launch': 'Start and resume agents in your workspaces, local and SSH',
  'terminal:send':
    'Open terminals, close the ones it opened or that are in your focused workspace, and type and run commands in your terminals, local and SSH',
  'terminal:read': 'Read the output of your terminals, local and SSH',
  'notifications:show': 'Show desktop notifications labeled with the plugin name',
  'storage:own': "Store data in the plugin's own storage folder",
  'secrets:own': "Store and read secrets in the plugin's own encrypted file",
  'settings:own': "Read and change the plugin's own settings",
  'appearance:write': 'Publish and select desktop application, editor and terminal colors',
  'workspace:create':
    "Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say",
  'automation:read':
    'Read your automations: their names, prompts, agents, projects, workspaces and schedules',
  'automation:write':
    'Create automations that start agents in your projects on a schedule, even when the plugin is not running, and change or delete them (Orca asks you first for ones the plugin did not create, and before it changes what one with extra agent settings runs)',
  'history:read':
    "Read the list of your past agent sessions on this computer, from the history files of the coding agents Orca supports, including running WSL distributions on Windows (not SSH or other machines, Antigravity IDE conversations or subagent transcripts): each session's title, which is often the start of its first message, agent, workspace, branch, times, and message and token counts; never the conversation itself"
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
