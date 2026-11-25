import { z } from 'zod'
import { AGENT_CLI_UPDATE_AGENTS } from '../../agent-launch/installation/agent-cli-update'

// Not strict, and unknown names are dropped, so a newer client's list never fails an older host.
export const AgentCliUpdateCheckParams = z.object({
  agents: z.array(z.string()).max(64).optional()
})

export const AgentCliUpdateRunParams = z.strictObject({ agent: z.enum(AGENT_CLI_UPDATE_AGENTS) })
