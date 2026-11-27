/** Advertised agentSession.agents lists registered agents/capabilities before sessions exist. Drop unreadable rows individually; unknown capability arms degrade to the least authority. */

import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { AgentSessionCapabilities } from '../capabilities/agent-session-capabilities'
import { isStructuredAgentId } from '../lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openEnum } from '../../validation/zod-salvage'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY } from '../../agent-launch/installation/managed-runtime-install'

export const AGENT_SESSION_AGENTS_METHOD = 'agentSession.agents'

export type AgentSessionRegisteredAgent = {
  agent: string
  capabilities: AgentSessionCapabilities
  /** Host-provided program needs no installed CLI; older hosts omit this and require CLI detection. */
  managedRuntime?: true
}

export type AgentSessionAgentsResult = {
  agents: AgentSessionRegisteredAgent[]
}

/** Bounds one reply; no host registers anywhere near this many agents. */
const MAX_REGISTERED_AGENTS = 128

// An absent flag is a capability the host did not claim.
const capabilityFlag = lazyZodSchema(() => z.boolean().optional().default(false))

const registeredAgentSchema = lazyZodSchema(() =>
  z.object({
    agent: z.string().refine(isStructuredAgentId),
    capabilities: z.object({
      rewind: capabilityFlag,
      compact: capabilityFlag,
      threadGoal: capabilityFlag,
      // Optional, like fork: absent stays absent, and anything but true offers no MCP panel.
      mcpServers: z.literal(true).optional().catch(undefined),
      contextUsage: capabilityFlag,
      imagePrompts: capabilityFlag,
      // An unknown fork level reads as absent: the host never forks for this client.
      fork: z.enum(['checkpoint', 'tip']).optional().catch(undefined),
      // Holding a follow-up until the turn ends never interrupts one the client cannot reason about.
      steering: openEnum(['inject', 'queue'] as const, 'queue')
        .optional()
        .default('queue'),
      // `orca` claims only that Orca answers the agent's requests, never that it confines the agent.
      approvalEnforcement: openEnum(['provider', 'orca'] as const, 'orca')
        .optional()
        .default('orca')
    }),
    // A false from a host reads as absent, so the row keeps the detection-based offer.
    managedRuntime: z.literal(true).optional().catch(undefined)
  })
)

/** The host's agents as this build reads them, or null when the reply is not an agent list. */
export function decodeAgentSessionAgentsResult(
  value: unknown
): AgentSessionRegisteredAgent[] | null {
  if (typeof value !== 'object' || value === null || !('agents' in value)) {
    return null
  }
  const { agents } = value
  if (!Array.isArray(agents)) {
    return null
  }
  const seen = new Set<string>()
  const decoded: AgentSessionRegisteredAgent[] = []
  for (const row of agents.slice(0, MAX_REGISTERED_AGENTS)) {
    const parsed = registeredAgentSchema.safeParse(row)
    if (parsed.success && !seen.has(parsed.data.agent)) {
      seen.add(parsed.data.agent)
      decoded.push(parsed.data)
    }
  }
  return decoded
}

/** The host installs this agent's chat program itself, so a chat needs no detected CLI. */
export function registeredAgentChatInstallable(
  registered:
    | readonly Pick<AgentSessionRegisteredAgent, 'agent' | 'managedRuntime'>[]
    | null
    | undefined,
  agent: string,
  hostCapabilities: readonly string[]
): boolean {
  return (
    hostCapabilities.includes(MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY) &&
    registered?.some((row) => row.agent === agent && row.managedRuntime === true) === true
  )
}
