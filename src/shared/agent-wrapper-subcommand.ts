import { TUI_AGENT_CONFIG, type TuiAgentConfig } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

// Why: a launch line whose binary is not the agent process (`orca claude-teams`, `openzoo claude`)
// is a wrapper whose other subcommands are not agents — `orca status` runs the Orca CLI, bare
// `openzoo` runs its payment proxy. Derived from the config so a wrapper cannot be registered
// without its guard; kiro/hermes/command-code keep their flags because their binary IS the agent.
const WRAPPER_SUBCOMMAND_BY_AGENT = new Map<TuiAgent, string>()
for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG) as [TuiAgent, TuiAgentConfig][]) {
  const [binary, subcommand] = config.launchCmd.split(/\s+/)
  if (subcommand && binary.toLowerCase() !== config.expectedProcess.toLowerCase()) {
    WRAPPER_SUBCOMMAND_BY_AGENT.set(agent, subcommand.toLowerCase())
  }
}

/** The subcommand that turns a wrapper binary into the hosted agent, or null for real agent binaries. */
export function getWrapperSubcommand(agent: TuiAgent): string | null {
  return WRAPPER_SUBCOMMAND_BY_AGENT.get(agent) ?? null
}

/** True when `agent` is a wrapper binary and `subcommand` is not the one that hosts its TUI. */
export function lacksWrapperSubcommand(
  agent: TuiAgent | undefined,
  subcommand: string | undefined
): boolean {
  const required = agent ? WRAPPER_SUBCOMMAND_BY_AGENT.get(agent) : undefined
  return required !== undefined && subcommand?.toLowerCase() !== required
}
