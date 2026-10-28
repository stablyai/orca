/**
 * `agentSession.subscribeAvailability`: the health of this host's installed agents, from each
 * agent's location rule and installed-release check on the host itself, not in any workspace.
 * Every frame is the complete snapshot and replaces the one before. Published only by hosts
 * advertising the availability capability; `agentSession.agents` stays the static list.
 */

import { z } from 'zod'
import { isStructuredAgentId } from './agent-session-provider-handle-encoding'
import { openEnum } from './zod-salvage'

export const AGENT_SESSION_AVAILABILITY_METHOD = 'agentSession.subscribeAvailability'

/** Whether the program a chat start runs is on this host: `installable` is absent but Orca can
 *  download it; `unknown` depends on the workspace or could not be read. Older hosts omit it. */
export type AgentSessionChatProgram = 'available' | 'installable' | 'missing' | 'unknown'

/** `refused` carries the reason (`agent`: this host cannot run its chat); `unknown` is a check that
 *  could not answer, which is never a refusal. */
export type AgentSessionAgentAvailability = (
  | { agent: string; state: 'available' }
  | { agent: string; state: 'refused'; reason?: string }
  | { agent: string; state: 'unknown' }
) & { chatProgram?: AgentSessionChatProgram }

export type AgentSessionAvailabilityFrame = {
  type: 'availability'
  agents: AgentSessionAgentAvailability[]
}

const MAX_AGENTS = 128

const rowSchema = z.object({
  agent: z.string().refine(isStructuredAgentId),
  // A state this build does not know claims nothing.
  state: openEnum(['available', 'refused', 'unknown'] as const, 'unknown'),
  reason: z.string().max(64).optional(),
  chatProgram: openEnum(['available', 'installable', 'missing', 'unknown'] as const, 'unknown')
    .optional()
    .catch(undefined)
})

/** One frame's answers by agent, or null when the frame is not an availability frame. */
export function decodeAgentSessionAvailabilityFrame(
  value: unknown
): ReadonlyMap<string, AgentSessionAgentAvailability> | null {
  if (typeof value !== 'object' || value === null || !('type' in value) || !('agents' in value)) {
    return null
  }
  if (value.type !== 'availability' || !Array.isArray(value.agents)) {
    return null
  }
  const byAgent = new Map<string, AgentSessionAgentAvailability>()
  for (const row of value.agents.slice(0, MAX_AGENTS)) {
    const parsed = rowSchema.safeParse(row)
    if (!parsed.success || byAgent.has(parsed.data.agent)) {
      continue
    }
    const { agent, state, reason, chatProgram } = parsed.data
    const program = chatProgram ? { chatProgram } : {}
    byAgent.set(
      agent,
      state === 'refused'
        ? { agent, state, ...(reason ? { reason } : {}), ...program }
        : { agent, state, ...program }
    )
  }
  return byAgent
}
