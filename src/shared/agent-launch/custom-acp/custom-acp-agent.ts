// User-defined ACP agents: a local command Orca runs as an ACP server for Chat.

import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { TuiAgent } from '../catalog/tui-agent'

/** Prefixed so a custom id never collides with a built-in agent or another host's built-in. */
export const CUSTOM_ACP_AGENT_ID_PREFIX = 'custom-acp-'

export type CustomAcpAgentId = `${typeof CUSTOM_ACP_AGENT_ID_PREFIX}${string}`

/** An agent a chat can run: a built-in, or a custom ACP agent the chat's host defines. */
export type ChatAgentId = TuiAgent | CustomAcpAgentId

export type CustomAcpAgent = {
  /** Stable across renames, so saved chats keep their agent. */
  id: CustomAcpAgentId
  name: string
  /** An executable path or a name looked up on PATH; never run through a shell. */
  command: string
  /** Literal arguments, one per entry. */
  args: string[]
  env: Record<string, string>
  /** Off keeps it out of new-chat menus; its existing chats still run. Absent means on. */
  disabled?: true
  /** The model new chats start on, as the agent names it; absent leaves the agent's own default. */
  defaultModel?: string
}

export type CustomAcpAgentSettings = {
  /** Local ACP commands this host runs as Chat agents; absent means none. */
  customAcpAgents?: CustomAcpAgent[]
  /** New agent tabs open this custom agent's chat while `defaultTuiAgent` is unset. Separate so
   *  features that need an agent CLI never see it; choosing a built-in default clears it. */
  defaultCustomAcpAgent?: CustomAcpAgentId | null
}

/** The saved custom default, when it still names an agent that is defined and switched on. */
export function savedCustomAcpDefaultAgent(
  settings: (CustomAcpAgentSettings & { defaultTuiAgent?: unknown }) | null | undefined
): CustomAcpAgent | null {
  const id = settings?.defaultCustomAcpAgent
  if (!isCustomAcpAgentId(id) || settings?.defaultTuiAgent) {
    return null
  }
  const agent = normalizeCustomAcpAgents(settings?.customAcpAgents).find((row) => row.id === id)
  return agent && !agent.disabled ? agent : null
}

export const CUSTOM_ACP_AGENT_LIMITS = {
  agents: 32,
  name: 64,
  command: 1024,
  args: 64,
  arg: 4096,
  model: 256,
  envEntries: 64,
  envValue: 8192
} as const

// Fits the structured agent slug (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`) with room for the prefix.
const ID_PATTERN = /^custom-acp-[a-z0-9][a-z0-9-]{0,47}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function isCustomAcpAgentId(value: unknown): value is CustomAcpAgentId {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

// Built on first parse, so a build that never reads custom agents keeps no schema objects.
const customAcpAgentSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().refine(isCustomAcpAgentId),
    name: z.string().trim().min(1).max(CUSTOM_ACP_AGENT_LIMITS.name),
    command: z.string().trim().min(1).max(CUSTOM_ACP_AGENT_LIMITS.command),
    args: z
      .array(z.string().max(CUSTOM_ACP_AGENT_LIMITS.arg))
      .max(CUSTOM_ACP_AGENT_LIMITS.args)
      .default([]),
    env: z
      .record(z.string().regex(ENV_NAME_PATTERN), z.string().max(CUSTOM_ACP_AGENT_LIMITS.envValue))
      .refine((env) => Object.keys(env).length <= CUSTOM_ACP_AGENT_LIMITS.envEntries)
      .default({}),
    // Anything but true reads as on, so a malformed flag never hides an agent.
    disabled: z.literal(true).optional().catch(undefined),
    defaultModel: z
      .string()
      .trim()
      .min(1)
      .max(CUSTOM_ACP_AGENT_LIMITS.model)
      .optional()
      .catch(undefined)
  })
)

/** The saved agents this build can run; each row parses alone, so one bad row hides no others. */
export function normalizeCustomAcpAgents(value: unknown): CustomAcpAgent[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const agents: CustomAcpAgent[] = []
  for (const row of value.slice(0, CUSTOM_ACP_AGENT_LIMITS.agents)) {
    const parsed = customAcpAgentSchema.safeParse(row).data
    const id = parsed?.id
    if (parsed && isCustomAcpAgentId(id) && !seen.has(id)) {
      seen.add(id)
      const { disabled, defaultModel, ...rest } = parsed
      agents.push({
        ...rest,
        id,
        ...(disabled ? { disabled } : {}),
        ...(defaultModel ? { defaultModel } : {})
      })
    }
  }
  return agents
}

/** A new id; `randomSuffix` returns lowercase hex or base36 so the id stays a valid slug. */
export function createCustomAcpAgentId(randomSuffix: () => string): CustomAcpAgentId {
  const suffix = randomSuffix()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)
  const id = `${CUSTOM_ACP_AGENT_ID_PREFIX}${suffix || '0'}`
  if (!isCustomAcpAgentId(id)) {
    throw new Error('custom ACP agent id is not a valid slug')
  }
  return id
}

export function isValidCustomAcpEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name)
}
