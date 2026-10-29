import type { ActivePluginCommand } from '@/store/plugin-panels'
import { dispatchAppCommand, type AppCommandSource } from './app-command-dispatch'

/** Resolves with whatever a worker handler returned; built-in actions return nothing. */
export async function executePluginCommand(
  command: ActivePluginCommand,
  source: AppCommandSource
): Promise<unknown> {
  if (command.handler.type === 'built-in') {
    if (!dispatchAppCommand(command.handler.action, source)) {
      throw new Error('built-in action is unavailable in the current context')
    }
    return undefined
  }
  return window.api.plugins.invokeCommand({
    pluginKey: command.pluginKey,
    commandId: command.id
  })
}
