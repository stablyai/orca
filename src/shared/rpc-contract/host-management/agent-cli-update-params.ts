import { z } from 'zod'
import { AGENT_CLI_UPDATE_AGENTS } from '../../agent-launch/installation/agent-cli-update'

export const AgentCliUpdateRunParams = z.strictObject({ agent: z.enum(AGENT_CLI_UPDATE_AGENTS) })
