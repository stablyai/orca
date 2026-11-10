import type { ActivePluginCommand } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { isWorkspaceScopedPluginContext } from '../../../shared/plugins/contributions/plugin-command-contribution'
import { dispatchAppCommand, type AppCommandSource } from './app-commands/app-command-dispatch'

/** Resolves with whatever a worker handler returned; built-in actions return nothing. A workspace
 *  command runs on `target`'s workspace (and badge folder), which main hands the worker as
 *  `args.worktree` (and `args.folder`). */
export async function executePluginCommand(
  command: ActivePluginCommand,
  source: AppCommandSource,
  target?: { worktreeId: string | null; folder?: string }
): Promise<unknown> {
  if (command.handler.type === 'built-in') {
    if (!dispatchAppCommand(command.handler.action, source)) {
      throw new Error('built-in action is unavailable in the current context')
    }
    return undefined
  }
  const worktreeId = isWorkspaceScopedPluginContext(command.context) ? target?.worktreeId : null
  return window.api.plugins.invokeCommand({
    pluginKey: command.pluginKey,
    commandId: command.id,
    ...(worktreeId
      ? { args: { worktreeId, ...(target?.folder ? { folder: target.folder } : {}) } }
      : {})
  })
}
