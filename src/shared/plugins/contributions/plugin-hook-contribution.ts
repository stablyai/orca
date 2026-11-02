import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import { pluginFieldDoc, PLUGIN_HOOKS_SINCE } from '../manifest/plugin-schema-field-docs'

/** Points where a worker can change or stop what Orca is about to do. Closed set: Orca waits
 *  only on plugins whose manifest lists the hook. */
export const PLUGIN_HOOK_NAMES = [
  'terminal.send',
  'workspace.create.before',
  'workspace.create.after',
  'agent.launch.before',
  'agent.prompt.before'
] as const
export const PLUGIN_HOOK_LIMIT = PLUGIN_HOOK_NAMES.length

export type PluginHookName = (typeof PLUGIN_HOOK_NAMES)[number]

/** The release each hook arrived in; engines.orca must cover every one a plugin lists. */
export const PLUGIN_HOOK_SINCE: Record<PluginHookName, string> = {
  'terminal.send': PLUGIN_HOOKS_SINCE,
  'workspace.create.before': PLUGIN_HOOKS_SINCE,
  'workspace.create.after': PLUGIN_HOOKS_SINCE,
  'agent.launch.before': PLUGIN_HOOKS_SINCE,
  'agent.prompt.before': PLUGIN_HOOKS_SINCE
}

export function isPluginHookName(name: string): name is PluginHookName {
  return PLUGIN_HOOK_NAMES.some((hook) => hook === name)
}

export const pluginHookContributionSchema = z
  .object({
    event: z.enum(PLUGIN_HOOK_NAMES).meta({
      ...pluginFieldDoc('Hook the worker handles with `orca.hooks.on`.', PLUGIN_HOOKS_SINCE),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_HOOK_SINCE
    })
  })
  .strict()
  .meta({
    id: 'HookContribution',
    description:
      'A hook Orca runs through the worker before (or after) it acts. Requires `main` and the `trusted-worker` execution profile.'
  })

export type PluginHookContribution = z.infer<typeof pluginHookContributionSchema>
