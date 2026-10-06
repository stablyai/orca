import { translate } from '@/i18n/i18n'
import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT,
  TERMINAL_PROCESS_LIMIT_HINT,
  TERMINAL_SPAWN_ISSUE_REQUEST
} from '../../../../shared/terminal-spawn-error-copy'

/** Swaps the host's English resource-limit hints for the viewer's locale. */
export function localizeTerminalSpawnHints(error: string): string {
  const ptyAllocation = translate(
    'auto.components.terminal.pane.TerminalErrorToast.ptyAllocationLimit',
    PTY_ALLOCATION_HINT
  )
  const processLimit = translate(
    'auto.components.terminal.pane.TerminalErrorToast.terminalProcessLimit',
    TERMINAL_PROCESS_LIMIT_HINT
  )
  // Why a replacer: a translation containing `$&` would otherwise be read as a substitution.
  return error
    .replaceAll(LEGACY_PTY_ALLOCATION_HINT, () => ptyAllocation)
    .replaceAll(PTY_ALLOCATION_HINT, () => ptyAllocation)
    .replaceAll(LEGACY_TERMINAL_PROCESS_LIMIT_HINT, () => processLimit)
    .replaceAll(TERMINAL_PROCESS_LIMIT_HINT, () => processLimit)
}

/** Drops the host's plain-text issue request where the toast renders its own linked one. */
export function withoutTerminalSpawnIssueRequest(error: string): string {
  const suffix = ` ${TERMINAL_SPAWN_ISSUE_REQUEST}`
  return error
    .split('\n')
    .map((line) =>
      line.includes('Failed to spawn shell "') && line.endsWith(suffix)
        ? line.slice(0, -suffix.length)
        : line
    )
    .join('\n')
}
