import { Blocks } from 'lucide-react'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'

export function buildPluginQuickActions(
  commands: readonly ActivePluginCommand[]
): CmdJQuickAction[] {
  return commands.map((command) => ({
    id: `plugin:${command.pluginKey}/${command.id}`,
    kind: 'action',
    title: command.title,
    description: translate(
      'auto.components.cmd.j.pluginQuickActions.description',
      '{{value0}} plugin command',
      { value0: command.pluginName }
    ),
    icon: Blocks,
    verbKeywords: [
      command.title,
      command.pluginName,
      translate('auto.components.cmd.j.pluginQuickActions.keyword', 'plugin command')
    ],
    isAvailable: (context) =>
      command.context === 'worktree' && !context.activeWorktreeId
        ? { available: false, reason: 'no-active-workspace' }
        : { available: true },
    run: async () => {
      await executePluginCommand(command, 'plugin-palette')
      return { status: 'ok' }
    }
  }))
}
