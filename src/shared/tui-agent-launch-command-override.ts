import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'

/**
 * Whether the user replaced this agent's launch command for terminal launches.
 *
 * The command applies only where the CLI runs in a terminal; structured native chat ignores it and
 * never routes on it. Terminal-backed chat reads it to skip the structured model catalog, which
 * lists the stock binary rather than the one this terminal runs.
 */
export function hasExplicitTuiLaunchCommand(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  agent: TuiAgent
): boolean {
  return Boolean(settings?.agentCmdOverrides?.[agent]?.trim())
}
