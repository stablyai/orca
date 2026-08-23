import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import type { TuiAgent } from './tui-agent'

export type QueuedAgentLaunchStartup = {
  command: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  launchToken?: string
  env?: Record<string, string>
}

function mintLaunchToken(): string {
  return globalThis.crypto.randomUUID()
}

function isBareRecognizedAgentCommand(command: string, agent: TuiAgent): boolean {
  const trimmed = command.trim()
  if (!trimmed || /\s/.test(trimmed)) {
    return false
  }
  return recognizeAgentProcessFromCommandLine(trimmed)?.agent === agent
}

/**
 * Stamps launchConfig + ORCA_AGENT_LAUNCH_TOKEN onto a queued TUI agent startup.
 * Plain shell commands stay tokenless so a later typed agent cannot inherit a sibling's authority.
 */
export function attachQueuedAgentLaunchAuthority<T extends QueuedAgentLaunchStartup>(
  startup: T
): T & QueuedAgentLaunchStartup {
  const recognizedAgent =
    startup.launchAgent ?? recognizeAgentProcessFromCommandLine(startup.command)?.agent
  if (!recognizedAgent) {
    return startup
  }
  if (
    !startup.launchConfig &&
    !startup.launchAgent &&
    !isBareRecognizedAgentCommand(startup.command, recognizedAgent)
  ) {
    return startup
  }
  const launchConfig =
    startup.launchConfig ?? buildSleepingAgentLaunchConfig({ agentCommand: startup.command })
  const launchToken = startup.launchToken ?? mintLaunchToken()
  return {
    ...startup,
    launchAgent: startup.launchAgent ?? recognizedAgent,
    launchConfig,
    launchToken,
    env: {
      ...startup.env,
      ORCA_AGENT_LAUNCH_TOKEN: launchToken
    }
  }
}
