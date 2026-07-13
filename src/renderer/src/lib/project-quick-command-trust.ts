import { useAppStore } from '@/store'
import {
  getTerminalQuickCommandScope,
  isProjectTerminalQuickCommand
} from '../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../shared/types'
import { ensureHooksConfirmed } from './ensure-hooks-confirmed'

/**
 * Gate execution of orca.yaml-provided quick commands behind the repo trust
 * prompt. Personal commands resolve true immediately; project commands ask
 * once per repo and re-prompt when the file's quick commands change.
 */
export async function ensureProjectQuickCommandTrusted(
  command: TerminalQuickCommand
): Promise<boolean> {
  if (!isProjectTerminalQuickCommand(command)) {
    return true
  }
  const scope = getTerminalQuickCommandScope(command)
  if (scope.type !== 'repo') {
    // Fail closed: a project command without a repo scope cannot be trust-checked.
    return false
  }
  const decision = await ensureHooksConfirmed(useAppStore.getState(), scope.repoId, 'quickCommands')
  return decision === 'run'
}
