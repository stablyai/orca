import { buildSetupRunnerCommand as buildSharedSetupRunnerCommand } from '../../../shared/setup-runner-command'

export function buildSetupRunnerCommand(runnerScriptPath: string): string {
  return buildSharedSetupRunnerCommand(
    runnerScriptPath,
    navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
  )
}
