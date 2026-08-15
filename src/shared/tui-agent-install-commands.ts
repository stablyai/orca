import type { TuiAgent } from './types'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  TUI_AGENT_INSTALL_SPECS,
  type AgentInstallPlatform,
  type TuiAgentInstallSpec
} from './tui-agent-install-specs'

export type { AgentInstallPlatform, TuiAgentInstallSpec }
export { TUI_AGENT_INSTALL_SPECS }

const INSTALL_SPEC_BY_AGENT = new Map(
  TUI_AGENT_INSTALL_SPECS.map((spec) => [spec.agent, spec] as const)
)

export const INSTALLABLE_TUI_AGENTS = TUI_AGENT_INSTALL_SPECS.map(
  (spec) => spec.agent
) as unknown as readonly [TuiAgent, ...TuiAgent[]]

export function isInstallableTuiAgent(agent: string): agent is TuiAgent {
  return INSTALL_SPEC_BY_AGENT.has(agent as TuiAgent)
}

export function toAgentInstallPlatform(
  platform: NodeJS.Platform | string | null | undefined
): AgentInstallPlatform | null {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform
  }
  return null
}

export function getAgentInstallSpec(agent: TuiAgent): TuiAgentInstallSpec | null {
  return INSTALL_SPEC_BY_AGENT.get(agent) ?? null
}

export function getAgentInstallCommand(
  agent: TuiAgent,
  platform: AgentInstallPlatform
): string | null {
  return getAgentInstallSpec(agent)?.commandByPlatform[platform] ?? null
}

export function getAgentInstallVerifyCommand(agent: TuiAgent): string {
  const override = getAgentInstallSpec(agent)?.verifyCmd
  if (override) {
    return override
  }
  return TUI_AGENT_CONFIG[agent]?.detectCmd ?? agent
}

export function getInstallableAgentsForPlatform(platform: AgentInstallPlatform): TuiAgent[] {
  return TUI_AGENT_INSTALL_SPECS.filter((spec) => Boolean(spec.commandByPlatform[platform])).map(
    (spec) => spec.agent
  )
}

export function diffMissingInstallableAgents(args: {
  localDetected: readonly string[]
  remoteDetected: readonly string[]
  platform: AgentInstallPlatform
}): {
  installable: TuiAgent[]
  manualOnly: TuiAgent[]
} {
  const remoteSet = new Set(args.remoteDetected)
  const installableForPlatform = new Set(getInstallableAgentsForPlatform(args.platform))
  const installable: TuiAgent[] = []
  const manualOnly: TuiAgent[] = []
  const seen = new Set<string>()

  for (const agentId of args.localDetected) {
    if (seen.has(agentId) || remoteSet.has(agentId)) {
      continue
    }
    seen.add(agentId)
    // Why: launch modes like claude-agent-teams are not standalone CLIs; skip
    // them so the dialog never offers a no-op install.
    if (agentId === 'claude-agent-teams') {
      continue
    }
    if (!isInstallableTuiAgent(agentId)) {
      // Unknown strings from stale detection should not enter either list.
      if (agentId in TUI_AGENT_CONFIG) {
        manualOnly.push(agentId as TuiAgent)
      }
      continue
    }
    if (installableForPlatform.has(agentId)) {
      installable.push(agentId)
    } else {
      manualOnly.push(agentId)
    }
  }

  return { installable, manualOnly }
}
