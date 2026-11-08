import type { PluginHostListEntry } from '../../../preload/api-types'
import { useAppStore } from '@/store'
import {
  collectActivePluginCommands,
  usePluginPanelsStore,
  type ActivePluginCommand
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { isWorkspaceScopedPluginContext } from '../../../shared/plugins/contributions/plugin-command-contribution'

/** Past this a replacing command's worker is not waited for: Orca's own action runs. */
export const PLUGIN_REPLACEMENT_TIMEOUT_MS = 2_000
/** Extra wait for main's answer before falling back on our own, should main never answer. */
export const PLUGIN_REPLACEMENT_UNANSWERED_GRACE_MS = 1_000

/** The plugin command that runs in place of each built-in action, minus those turned off. */
export function collectPluginReplacements(
  plugins: readonly PluginHostListEntry[],
  turnedOff: readonly string[] = [],
  hasActiveWorkspace = true
): Map<string, ActivePluginCommand> {
  const replacements = new Map<string, ActivePluginCommand>()
  for (const command of collectActivePluginCommands(plugins)) {
    const action = command.replaces
    // A workspace command is unavailable without a workspace, here as in the palette.
    const available = hasActiveWorkspace || !isWorkspaceScopedPluginContext(command.context)
    if (
      action &&
      available &&
      !command.replacedBy &&
      !turnedOff.includes(action) &&
      !replacements.has(action)
    ) {
      replacements.set(action, command)
    }
  }
  return replacements
}

export function pluginReplacementFor(actionId: string): ActivePluginCommand | null {
  const { settings, activeWorktreeId } = useAppStore.getState()
  const { plugins } = usePluginPanelsStore.getState()
  return (
    collectPluginReplacements(
      plugins,
      settings?.pluginReplacementsOff ?? [],
      Boolean(activeWorktreeId)
    ).get(actionId) ?? null
  )
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
  // Why main decides the 2 s cutoff: it rejects at the deadline and from then refuses the late
  // handler's commands.run of this action, so falling back on main's answer cannot repeat it.
  // This timer only covers a main process that never answers.
  const timer = setTimeout(
    fallBack,
    PLUGIN_REPLACEMENT_TIMEOUT_MS + PLUGIN_REPLACEMENT_UNANSWERED_GRACE_MS
  )
  // Why the timeout too: a worker that starts after the fallback must not run the command as well.
  window.api.plugins
    .invokeCommand({
      pluginKey: command.pluginKey,
      commandId: command.id,
      timeoutMs: PLUGIN_REPLACEMENT_TIMEOUT_MS
    })
    .then(
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
