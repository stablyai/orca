import { GENERATED_AGENT_LAUNCH_ENV } from '../../../../../shared/agent-launch/startup/generated-agent-launch-inputs'
import { ORCA_HERMES_STARTUP_QUERY_ARGV_ENV } from '../../../../../shared/agent-launch/startup/hermes-startup-query'
import type { WorktreeStartupLaunch } from '../../../../../shared/worktree/creation/launch-types'

type TerminalAgentLaunchParams = {
  command?: string
  env?: Record<string, string>
  generatedAgentLaunch?: string
  hermesStartupQueryArgv?: string
}

export function terminalAgentCreateLaunchParams(
  command: string | undefined,
  env: Record<string, string> | undefined
): TerminalAgentLaunchParams {
  if (!env || !(GENERATED_AGENT_LAUNCH_ENV in env || ORCA_HERMES_STARTUP_QUERY_ARGV_ENV in env)) {
    return { ...(command !== undefined ? { command } : {}), ...(env ? { env } : {}) }
  }
  const {
    [GENERATED_AGENT_LAUNCH_ENV]: generatedAgentLaunch,
    [ORCA_HERMES_STARTUP_QUERY_ARGV_ENV]: hermesStartupQueryArgv,
    ...paneEnv
  } = env
  return {
    ...(command !== undefined ? { command } : {}),
    ...(Object.keys(paneEnv).length ? { env: paneEnv } : {}),
    ...(command && generatedAgentLaunch ? { generatedAgentLaunch } : {}),
    ...(command && hermesStartupQueryArgv ? { hermesStartupQueryArgv } : {})
  }
}

export function worktreeAgentStartupParams(startup: WorktreeStartupLaunch) {
  const {
    command: startupCommand,
    env: startupEnv,
    ...rebuild
  } = terminalAgentCreateLaunchParams(startup.command, startup.env)
  return {
    startupCommand,
    ...(startupEnv ? { startupEnv } : {}),
    ...rebuild
  }
}
