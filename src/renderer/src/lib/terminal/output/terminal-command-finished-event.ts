export const ORCA_TERMINAL_COMMAND_FINISHED_EVENT = 'orca:terminal-command-finished'

export type TerminalCommandFinishedEventDetail = {
  worktreeId: string
  // OSC 133;D may omit the command's exit code.
  exitCode: number | null
}

// Window events let decoupled consumers observe per-pane OSC completion without accessing terminal internals.
export function dispatchTerminalCommandFinishedEvent(
  worktreeId: string,
  exitCode: number | null
): void {
  // Why: unit tests and non-DOM renderer shims may expose only the preload API.
  if (typeof window.dispatchEvent !== 'function') {
    return
  }

  window.dispatchEvent(
    new CustomEvent<TerminalCommandFinishedEventDetail>(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, {
      detail: { worktreeId, exitCode }
    })
  )
}
