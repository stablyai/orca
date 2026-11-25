import type { PaneProcessExit } from './pane-process-exit'
import type { PtyPaneStartup } from '../pty-connection/startup/pty-pane-startup'

export function resolveTerminalProcessExitRestartStartup(
  processExit: PaneProcessExit
): PtyPaneStartup {
  return processExit.reason === 'git-bash-console-capacity' ? processExit.startup : null
}
