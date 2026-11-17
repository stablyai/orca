import { structuredAgentLaunchDowngrade } from './agent-launch-routing'
import type { AgentLaunchRoute, AgentLaunchRoutingInput } from './agent-launch-routing'

/** The console line for a chat preference that opens a terminal; null when there is none. */
export function logStructuredLaunchDowngrade(
  input: AgentLaunchRoutingInput,
  route: AgentLaunchRoute
): ReturnType<typeof structuredAgentLaunchDowngrade> {
  const downgrade = structuredAgentLaunchDowngrade(input, route)
  if (downgrade) {
    console.warn(
      `[agent-launch-route] ${input.agent} opens ${route}: ${downgrade} (host ${input.executionHostId}, ` +
        `host agents ${input.hostStructuredAgents ? 'listed' : 'not learned'}, ` +
        `host capabilities ${input.hostCapabilities ? 'known' : 'unknown'})`
    )
  }
  return downgrade
}
