import { isValidAppVersion } from './app-version'
import type { CodexInstallationProblem } from './codex-cli-installation'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

/** Name the agent in installation refusals so replays/mobile can identify it without chat context. */
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

/** Include legacy Codex fields for clients predating agentInstallation. */
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
