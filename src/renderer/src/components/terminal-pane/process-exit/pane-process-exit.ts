import type { PtyPaneStartup } from '../pty-connection/startup/pty-pane-startup'

export type PaneProcessExit = {
  paneId: number
  exitCode: number
  reason: 'git-bash-console-capacity' | 'process-failed'
  startup: PtyPaneStartup
}
