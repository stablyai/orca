import type { z } from 'zod'
import type { AgentLaunch } from './rpc-contract/agent-launch-params'

/** `agent.launch` params a pane hands its own spawn; main names the pane, and nothing is recorded. */
export type AgentPaneLaunchRequest = {
  launch: Omit<z.input<typeof AgentLaunch>, 'paneKey' | 'operationId'>
}
