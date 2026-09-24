import {
  applySetupAutoCloseSetting,
  buildSetupRunnerCommand as buildSharedSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../shared/setup-runner-command'
import type { SetupRunnerShell } from '../../../shared/setup-runner-command'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'

function getSetupRunnerPlatform(runnerScriptPath: string): 'windows' | 'posix' {
  // Why: the runner may live on a remote/WSL filesystem, so the shell follows
  // the runner path format rather than the local renderer OS.
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
