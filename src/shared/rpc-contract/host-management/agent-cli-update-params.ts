import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { AGENT_CLI_UPDATE_AGENTS } from '../../agent-launch/installation/agent-cli-update'

// Not strict, and unknown names are dropped, so a newer client's list never fails an older host.
export const AgentCliUpdateCheckParams = lazyZodSchema(() =>
  z.object({
    agents: z.array(z.string()).max(64).optional()
  })
)

export const AgentCliUpdateRunParams = lazyZodSchema(() =>
  z.strictObject({ agent: z.enum(AGENT_CLI_UPDATE_AGENTS) })
)
