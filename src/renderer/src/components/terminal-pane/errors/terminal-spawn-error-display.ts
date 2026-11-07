import { translate } from '@/i18n/i18n'
import { resolveClientEnvironmentFooter } from '@/lib/client-environment-info'
import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT,
  TERMINAL_HOST_CAP_HINT,
  TERMINAL_PROCESS_LIMIT_HINT,
  TERMINAL_SPAWN_ISSUE_REQUEST
} from '../../../../../shared/terminal/pty/lifecycle/terminal-spawn-error-copy'

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
  const hostCap = translate(
    'auto.components.terminal.pane.TerminalErrorToast.hostTerminalCap',
    TERMINAL_HOST_CAP_HINT
  )
  // Why a replacer: a translation containing `$&` would otherwise be read as a substitution.
  return error
    .replaceAll(LEGACY_PTY_ALLOCATION_HINT, () => ptyAllocation)
    .replaceAll(PTY_ALLOCATION_HINT, () => ptyAllocation)
    .replaceAll(LEGACY_TERMINAL_PROCESS_LIMIT_HINT, () => processLimit)
    .replaceAll(TERMINAL_PROCESS_LIMIT_HINT, () => processLimit)
    .replaceAll(TERMINAL_HOST_CAP_HINT, () => hostCap)
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

const FAILED_SPAWN_SHELL = /failed to spawn shell "([^"\r\n]+)"/i

/** The shell a failed spawn names, which the footer reports instead of the client's default shell. */
export function failedSpawnShell(error: string): string | null {
  return FAILED_SPAWN_SHELL.exec(error)?.[1] ?? null
}

/** The client environment footer, naming the failed spawn's own shell (wsl.exe, say) over the default one. */
export function failedSpawnEnvironmentFooter(error: string): Promise<string> {
  const shell = failedSpawnShell(error)
  return resolveClientEnvironmentFooter(shell ? { shell } : {})
}
