import { invokeRuntimePluginCommand } from '@/runtime/runtime-plugin-client'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { dispatchAppCommand, type AppCommandSource } from './app-command-dispatch'

export async function executePluginCommand(
  command: ActivePluginCommand,
  source: AppCommandSource
): Promise<void> {
  if (command.handler.type === 'built-in') {
    if (!dispatchAppCommand(command.handler.action, source)) {
      throw new Error('built-in action is unavailable in the current context')
    }
    return
  }
  if (command.runtimeEnvironmentId) {
    await invokeRuntimePluginCommand(command.runtimeEnvironmentId, command.pluginKey, command.id)
    return
  }
  await window.api.plugins.invokeCommand({
    pluginKey: command.pluginKey,
    commandId: command.id
  })
}
