import {
  buildSetupRunnerCommand as buildSharedSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../../../../shared/agent-launch/startup/setup-runner-command'
import type { SetupRunnerShell } from '../../../../../../shared/agent-launch/startup/setup-runner-command'

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  shell?: SetupRunnerShell
): string {
  // Choose shell by runner path flavor, not renderer OS; it may live on remote/WSL storage.
  return buildSharedSetupRunnerCommand(
    runnerScriptPath,
    getSetupRunnerCommandPlatformForPath(
      runnerScriptPath,
      navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
    ),
    shell
  )
}
