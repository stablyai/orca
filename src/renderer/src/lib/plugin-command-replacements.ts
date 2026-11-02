import type { PluginHostListEntry } from '../../../preload/api-types'
import { useAppStore } from '@/store'
import {
  collectActivePluginCommands,
  usePluginPanelsStore,
  type ActivePluginCommand
} from '@/store/plugin-panels'
import { executePluginCommand } from './plugin-command-execution'

/** Past this a replacing command's worker is not waited for: Orca's own action runs. */
export const PLUGIN_REPLACEMENT_TIMEOUT_MS = 2_000

/** The plugin command that runs in place of each built-in action, minus those turned off. */
export function collectPluginReplacements(
  plugins: readonly PluginHostListEntry[],
  turnedOff: readonly string[] = []
): Map<string, ActivePluginCommand> {
  const replacements = new Map<string, ActivePluginCommand>()
  for (const command of collectActivePluginCommands(plugins)) {
    const action = command.replaces
    if (action && !command.replacedBy && !turnedOff.includes(action) && !replacements.has(action)) {
      replacements.set(action, command)
    }
  }
  return replacements
}

export function pluginReplacementFor(actionId: string): ActivePluginCommand | null {
  const turnedOff = useAppStore.getState().settings?.pluginReplacementsOff ?? []
  const { plugins } = usePluginPanelsStore.getState()
  return collectPluginReplacements(plugins, turnedOff).get(actionId) ?? null
}

/**
 * Runs the plugin command that replaces `actionId`, or `builtIn` when none does. A worker that
 * fails, or answers after 2 s, gets Orca's own action instead.
 */
export function runBuiltInOrReplacement(actionId: string, builtIn: () => void): void {
  const command = pluginReplacementFor(actionId)
  if (!command) {
    builtIn()
    return
  }
  let settled = false
  const fallBack = (): void => {
    if (!settled) {
      settled = true
      builtIn()
    }
  }
  const timer = setTimeout(fallBack, PLUGIN_REPLACEMENT_TIMEOUT_MS)
  executePluginCommand(command, 'plugin-replacement').then(
    () => {
      clearTimeout(timer)
      settled = true
    },
    (error: unknown) => {
      clearTimeout(timer)
      console.warn(
        `[plugins] ${command.pluginKey}/${command.id} failed; running ${actionId}`,
        error
      )
      fallBack()
    }
  )
}
