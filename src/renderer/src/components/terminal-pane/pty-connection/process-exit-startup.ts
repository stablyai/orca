import type { PtyPaneStartup } from '../pty-connection-types'

import type { ColdRestoreAgentResumeStartup, PendingStartupCommand } from './fresh-spawn-types'

export function toProcessExitStartup(
  startup: PendingStartupCommand | ColdRestoreAgentResumeStartup | null
): PtyPaneStartup {
  return startup && 'agent' in startup
    ? { ...startup, launchAgent: startup.agent, showSessionRestoredBanner: true }
    : startup
}
