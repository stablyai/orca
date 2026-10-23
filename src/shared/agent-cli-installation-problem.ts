import { isValidAppVersion } from './app-version'
import type { CodexInstallationProblem } from './codex-cli-installation'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

/** A chat start refused because the agent's binary is older than its chats need; names the agent
 *  so a replayed or phone refusal says whose without the chat. */
export type AgentCliInstallationProblem = {
  agent: TuiAgent
  installedVersion: string
  minimumVersion: string
}

export function readAgentCliInstallationProblem(
  value: unknown
): AgentCliInstallationProblem | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('agent' in value) ||
    !('installedVersion' in value) ||
    !('minimumVersion' in value) ||
    !isTuiAgent(value.agent) ||
    typeof value.installedVersion !== 'string' ||
    !isValidAppVersion(value.installedVersion) ||
    typeof value.minimumVersion !== 'string' ||
    !isValidAppVersion(value.minimumVersion)
  ) {
    return undefined
  }
  return {
    agent: value.agent,
    installedVersion: value.installedVersion,
    minimumVersion: value.minimumVersion
  }
}

/** A refusal's facts for `problem`; Codex's are also sent the way clients before
 *  `agentInstallation` read them. */
export function agentCliInstallationFacts(problem: AgentCliInstallationProblem): {
  agentInstallation: AgentCliInstallationProblem
  codexInstallation?: CodexInstallationProblem
} {
  const { agent, installedVersion, minimumVersion } = problem
  return {
    agentInstallation: problem,
    ...(agent === 'codex' ? { codexInstallation: { installedVersion, minimumVersion } } : {})
  }
}
