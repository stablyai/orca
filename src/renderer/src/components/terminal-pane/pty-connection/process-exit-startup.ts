import type { PtyPaneStartup } from '../pty-connection-types'

import type { ColdRestoreAgentResumeStartup, PendingStartupCommand } from './fresh-spawn-types'

export function toProcessExitStartup(
  startup: PendingStartupCommand | ColdRestoreAgentResumeStartup | null
): PtyPaneStartup {
  return startup && 'launchConfig' in startup && 'agent' in startup
    ? {
        command: startup.command,
        env: startup.env,
        launchConfig: startup.launchConfig,
        resumeProviderSession: startup.resumeProviderSession,
        launchToken: startup.launchToken,
        launchAgent: startup.agent,
        showSessionRestoredBanner: true
      }
    : stripSessionRestartCallback(startup)
}

function stripSessionRestartCallback(
  startup: PendingStartupCommand | ColdRestoreAgentResumeStartup | null
): PtyPaneStartup {
  if (!startup || !('onSessionRestartSettled' in startup) || !startup.onSessionRestartSettled) {
    return startup
  }
  const { onSessionRestartSettled: _settled, ...rest } = startup
  return rest
}
