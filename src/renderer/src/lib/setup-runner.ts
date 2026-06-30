import {
  buildSetupRunnerCommand as buildSharedSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../shared/setup-runner-command'
import type { SetupRunnerShell } from '../../../shared/setup-runner-command'

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  shell?: SetupRunnerShell
): string {
  // Why: the runner may live on a remote/WSL filesystem, so the shell follows
  // the runner path format rather than the local renderer OS.
  return buildSharedSetupRunnerCommand(
    runnerScriptPath,
    getSetupRunnerCommandPlatformForPath(
      runnerScriptPath,
      navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
    ),
    shell
  )
}
