import type { PaneProcessExit, PtyPaneStartup } from './pty-connection-types'

export function resolveTerminalProcessExitRestartStartup(
  processExit: PaneProcessExit
): PtyPaneStartup {
  return processExit.reason === 'git-bash-console-capacity' ? processExit.startup : null
}
