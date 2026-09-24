import {
  applySetupAutoCloseSetting,
  buildSetupRunnerCommand as buildSharedSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../../../../shared/agent-launch/startup/setup-runner-command'
import type { SetupRunnerShell } from '../../../../../../shared/agent-launch/startup/setup-runner-command'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { WorktreeSetupLaunch } from '../../../../../../shared/worktree/creation/launch-types'

function getSetupRunnerPlatform(runnerScriptPath: string): 'windows' | 'posix' {
  // Choose shell by runner path flavor, not renderer OS; it may live on remote/WSL storage.
  return getSetupRunnerCommandPlatformForPath(
    runnerScriptPath,
    navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
  )
}

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  shell?: SetupRunnerShell
): string {
  return buildSharedSetupRunnerCommand(
    runnerScriptPath,
    getSetupRunnerPlatform(runnerScriptPath),
    shell
  )
}

/** Honours "Close setup tab when it succeeds" for a command that launches `setup`. */
export function applySetupAutoClose(
  command: string,
  setup: Pick<WorktreeSetupLaunch, 'runnerScriptPath' | 'shell'>,
  settings:
    | Pick<GlobalSettings, 'closeSetupTabOnSuccess' | 'terminalWindowsShell'>
    | null
    | undefined
): string {
  return applySetupAutoCloseSetting(
    command,
    getSetupRunnerPlatform(setup.runnerScriptPath),
    setup.shell,
    settings
  )
}
