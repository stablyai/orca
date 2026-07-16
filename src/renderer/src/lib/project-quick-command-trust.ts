import { useAppStore } from '@/store'
import {
  getProjectTerminalQuickCommands,
  getTerminalQuickCommandScope,
  isProjectTerminalQuickCommand
} from '../../../shared/terminal-quick-commands'
import type { OrcaHooks, TerminalQuickCommand } from '../../../shared/types'
import { ensureHooksConfirmed } from './ensure-hooks-confirmed'

/**
 * Gate execution of orca.yaml-provided quick commands behind the repo trust
 * prompt. Personal commands pass through unchanged; project commands ask once
 * per repo and re-prompt when the file's quick commands change.
 *
 * Returns the command to execute, or null when execution must not happen.
 * For project commands the returned command is re-projected from the same
 * orca.yaml read the trust hash covered — the cached menu copy may be stale
 * (the file can change between menu load and click), and executing it would
 * run content the trust prompt never showed.
 */
export async function ensureProjectQuickCommandTrusted(
  command: TerminalQuickCommand
): Promise<TerminalQuickCommand | null> {
  if (!isProjectTerminalQuickCommand(command)) {
    return command
  }
  const scope = getTerminalQuickCommandScope(command)
  if (scope.type !== 'repo') {
    // Fail closed: a project command without a repo scope cannot be trust-checked.
    return null
  }
  let inspectedHooks: OrcaHooks | null | undefined
  const decision = await ensureHooksConfirmed(
    useAppStore.getState(),
    scope.repoId,
    'quickCommands',
    undefined,
    undefined,
    {
      onSharedHooksInspected: (yamlHooks) => {
        inspectedHooks = yamlHooks
      }
    }
  )
  if (decision !== 'run') {
    return null
  }
  if (inspectedHooks === undefined) {
    // Always-trusted repos resolve before any hooks read; the cached command
    // is as current as anything we could re-read now.
    return command
  }
  const fresh = getProjectTerminalQuickCommands(inspectedHooks?.quickCommands, scope.repoId)
  // Keep the menu cache honest: it should reflect the read the user just acted on.
  useAppStore.setState((s) => ({
    projectQuickCommandsByRepo: { ...s.projectQuickCommandsByRepo, [scope.repoId]: fresh }
  }))
  return fresh.find((candidate) => candidate.id === command.id) ?? null
}
