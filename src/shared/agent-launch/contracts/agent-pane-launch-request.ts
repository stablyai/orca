import type { z } from 'zod'
import type { AgentLaunch } from '../../rpc-contract/agent-launch/agent-launch-params'

/** `agent.launch` params a pane hands its own spawn; main names the pane, and nothing is recorded. */
export type AgentPaneLaunchRequest = {
  launch: Omit<z.input<typeof AgentLaunch>, 'paneKey' | 'operationId'>
  /** The window submits a prompt into this agent once it starts, so no startup update may take it. */
  suppressStartupUpdatePrompt?: boolean
  extraAgentArgs?: string
  startupPromptCarry?: 'force-line'
  /** Background owners report the launch failure in their existing run result. */
  returnLaunchFailure?: boolean
}
