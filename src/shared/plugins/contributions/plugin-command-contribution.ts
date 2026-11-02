import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import {
  PLUGIN_COMMAND_ACTION_SINCE,
  PLUGIN_COMMAND_ALIAS_ACTION_IDS
} from './plugin-command-actions'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import { pluginCommandIdSchema } from '../manifest/plugin-manifest-fields'
import {
  pluginFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from '../manifest/plugin-schema-field-docs'

export const PLUGIN_COMMAND_LIMIT = 256
/** First release that reads `commands[].replaces`. */
export const PLUGIN_COMMAND_REPLACES_SINCE = '1.4.248'

// Why `workspace`: folder workspaces exist too; format 1's `worktree` is rewritten on parse.
// Why `when`: it is meant to grow into an expression (`workspaceKind == folder`, `remote`) in
// which the bare `global` and `workspace` stay valid, so the shape never has to change.
export const pluginCommandWhenSchema = z.enum(['global', 'workspace'])
/** Why not `=== 'workspace'`: hosts from before the rename still send `worktree`. */
export function isWorkspaceScopedPluginContext(context: string | undefined): boolean {
  return context !== undefined && context !== 'global'
}

export const PLUGIN_COMMAND_WHEN_SINCE = {
  [PLUGIN_ENUM_SINCE_KEY]: { global: PLUGIN_SCHEMA_SINCE_V1, workspace: PLUGIN_MANIFEST_V2_SINCE }
}

export const pluginCommandContributionSchema = z
  .object({
    id: pluginCommandIdSchema.meta(
      pluginFieldDoc(
        "Command id, unique among this plugin's commands. Dotted namespaces are allowed.",
        PLUGIN_SCHEMA_SINCE_V1,
        ['jupyter.restartKernel']
      )
    ),
    title: safePluginDisplayText(z.string().min(1).max(256)).meta(
      pluginFieldDoc('Title shown in the command palette.', PLUGIN_SCHEMA_SINCE_V1, [
        'Restart kernel'
      ])
    ),
    when: pluginCommandWhenSchema.optional().meta({
      ...pluginFieldDoc(
        'Where the command is available. `workspace` hides it when no workspace is active. Defaults to `global`.',
        PLUGIN_SCHEMA_SINCE_V1
      ),
      ...PLUGIN_COMMAND_WHEN_SINCE
    }),
    action: pluginCommandIdSchema.optional().meta({
      ...pluginFieldDoc(
        'Built-in Orca action this command runs. A command with an action is declarative and never starts the plugin worker; one without needs `main`.',
        PLUGIN_SCHEMA_SINCE_V1,
        ['view.tasks']
      ),
      // Why: the runtime refinement accepts exactly this set, so editors can complete it.
      enum: [...PLUGIN_COMMAND_ALIAS_ACTION_IDS],
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_COMMAND_ACTION_SINCE
    }),
    replaces: pluginCommandIdSchema.optional().meta({
      ...pluginFieldDoc(
        'Built-in Orca action this worker command runs in place of, from its shortcut, the palette or a menu. If the worker fails or takes over 2 s, Orca runs its own. The person sees it before approving and can turn it off in Settings; when two plugins replace one action, the one installed first does.',
        PLUGIN_COMMAND_REPLACES_SINCE,
        ['view.tasks']
      ),
      enum: [...PLUGIN_COMMAND_ALIAS_ACTION_IDS]
    })
  })
  .strict()
  .meta({
    id: 'CommandContribution',
    description: 'A command palette entry. Requires the `declarative` execution profile or higher.'
  })

export type PluginCommandContribution = z.infer<typeof pluginCommandContributionSchema>
