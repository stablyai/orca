import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveLaunchExitWithPresence,
  resolvePaneAgentWithPresence
} from './agent-presence-selectors'
import {
  resolveLegacyLaunchedAgentExitEvidence,
  resolveLegacyTabAgentFromSignals
} from './legacy-unidentified-agent-presence'

/** `agentPresence` is the focused pane's host record; siblings keep their legacy row signals. */
export function resolveTabAgentFromSignals(
  args: Parameters<typeof resolveLegacyTabAgentFromSignals>[0] & {
    agentPresence?: AgentProcessPresence
  }
): TuiAgent | null {
  return resolvePaneAgentWithPresence(args.agentPresence, args, resolveLegacyTabAgentFromSignals)
}

export function resolveLaunchedAgentExitEvidence(
  args: Parameters<typeof resolveLegacyLaunchedAgentExitEvidence>[0] & {
    agentPresence?: AgentProcessPresence
    launchAgent?: TuiAgent
  }
): boolean {
  return resolveLaunchExitWithPresence(
    args.agentPresence,
    args.launchAgent,
    args,
    resolveLegacyLaunchedAgentExitEvidence
  )
}
