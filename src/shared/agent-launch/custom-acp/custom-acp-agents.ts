import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** A chat agent the user runs over ACP with their own command, such as `ssh host my-agent acp`. */
export type CustomAcpAgent = {
  /** Slug; the chat's agent id is `custom-<id>`. */
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type CustomAcpAgentId = `custom-${string}`

export type CustomAcpAgentSettings = {
  /** The host's own ACP agents, offered as chats beside the built-in ones; read when Orca starts. */
  customAcpAgents?: CustomAcpAgent[]
}

const CUSTOM_ACP_AGENT_PREFIX = 'custom-'

// Agent ids are bounded slugs (isStructuredAgentId); the prefix keeps them apart from built-in agents.
export const CustomAcpAgentSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
    name: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1),
    args: z.array(z.string()),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
  })
)

export const CustomAcpAgentsSchema = lazyZodSchema(() => z.array(CustomAcpAgentSchema))

export function customAcpAgentId(agent: Pick<CustomAcpAgent, 'id'>): CustomAcpAgentId {
  return `${CUSTOM_ACP_AGENT_PREFIX}${agent.id}`
}

export function isCustomAcpAgentId(agent: string): agent is CustomAcpAgentId {
  return agent.startsWith(CUSTOM_ACP_AGENT_PREFIX)
}

/** The valid entries of a saved list, first one winning a repeated id; a bad entry never blocks the rest. */
export function readCustomAcpAgents(value: unknown): CustomAcpAgent[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  return value.flatMap((entry) => {
    const parsed = CustomAcpAgentSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) {
      return []
    }
    seen.add(parsed.data.id)
    return [parsed.data]
  })
}
