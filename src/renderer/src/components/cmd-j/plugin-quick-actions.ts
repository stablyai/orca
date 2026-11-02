import { Blocks, FilePlus } from 'lucide-react'
import { isWorkspaceScopedPluginContext } from '../../../../shared/plugins/contributions/plugin-command-contribution'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { translate } from '@/i18n/i18n'
import type { ActivePluginNewFile } from '@/store/plugin-new-files'
import { useAppStore } from '@/store'
import { runWorkspaceAction, type CmdJQuickAction } from './quick-actions'
import { getWorkspaceScopedActionAvailability } from './quick-action-context'

/** A plugin's new-file types, created like New Markdown File in the active workspace. */
export function buildPluginNewFileQuickActions(
  newFiles: readonly ActivePluginNewFile[]
): CmdJQuickAction[] {
  return newFiles.map((newFile) => ({
    id: `plugin-new-file:${newFile.key}`,
    kind: 'action',
    title: newFile.title,
    description: translate(
      'auto.components.cmd.j.pluginQuickActions.newFileDescription',
      'Create an untitled {{value0}} file in the active workspace.',
      { value0: newFile.extension }
    ),
    icon: FilePlus,
    verbKeywords: [
      newFile.title,
      newFile.extension,
      newFile.pluginName,
      translate('auto.components.cmd.j.quick.actions.verbs.newFile', 'new file')
    ],
    isAvailable: getWorkspaceScopedActionAvailability,
    run: (ctx) =>
      runWorkspaceAction(ctx, (groupId) =>
        useAppStore.getState().openNewPluginFileInActiveWorkspace(newFile, groupId)
      )
  }))
}

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
      isWorkspaceScopedPluginContext(command.context) && !context.activeWorktreeId
        ? { available: false, reason: 'no-active-workspace' }
        : { available: true },
    run: async () => {
      await executePluginCommand(command, 'plugin-palette')
      return { status: 'ok' }
    }
  }))
}
