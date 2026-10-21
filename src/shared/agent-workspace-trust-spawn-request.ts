import { z } from 'zod'

/**
 * Optional `pty.spawn` field: the desktop decided to pre-trust `workspacePath` for this launch
 * (setting on, fresh launch). The relay derives the preset from `launchAgent` and writes on
 * its own disk; a relay that does not know the field ignores it, so the agent just asks.
 */
export type AgentWorkspaceTrustSpawnRequest = {
  workspacePath: string
}

const agentWorkspaceTrustSpawnRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export function parseAgentWorkspaceTrustSpawnRequest(
  value: unknown
): AgentWorkspaceTrustSpawnRequest | null {
  const parsed = agentWorkspaceTrustSpawnRequestSchema.safeParse(value)
  return parsed.success ? { workspacePath: parsed.data.workspacePath } : null
}
