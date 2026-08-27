/**
 * Maps a stalled pane's agent to the provider whose rate-limit window governs
 * it, so recovery can wait for a real reset instead of guessing.
 *
 * Deliberately partial: an agent with no provider window Orca tracks returns
 * null, and the policy then holds that pane for the user rather than inventing
 * a reset time.
 */

import type { AgentType } from './agent-status-types'
import type { RateLimitState } from './rate-limit-types'

/** Keyed the way RateLimitState is, not the way `provider` strings read —
 *  `opencode-go` lives under `opencodeGo`. */
export type AgentStallRateLimitProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencodeGo'
  | 'grok'
  | 'antigravity'

const PROVIDER_BY_AGENT_TYPE: Readonly<Record<string, AgentStallRateLimitProvider>> = {
  claude: 'claude',
  openclaude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'antigravity',
  opencode: 'opencodeGo',
  grok: 'grok'
}

export function rateLimitProviderForAgentType(
  agentType: AgentType | null | undefined
): AgentStallRateLimitProvider | null {
  const key = agentType?.trim().toLowerCase()
  return key ? (PROVIDER_BY_AGENT_TYPE[key] ?? null) : null
}

/**
 * When this agent's provider window reopens, or null when Orca cannot say.
 *
 * Takes the LATEST reset across the windows that are actually spent: a weekly
 * cap that outlives the 5-hour session window is the one that still refuses the
 * turn, so recovering at the session reset would burn the attempt.
 */
export function agentStallRateLimitResetAt(
  rateLimits: Pick<RateLimitState, AgentStallRateLimitProvider> | null | undefined,
  agentType: AgentType | null | undefined
): number | null {
  const provider = rateLimitProviderForAgentType(agentType)
  if (!provider || !rateLimits) {
    return null
  }
  const limits = rateLimits[provider]
  if (!limits) {
    return null
  }
  const spentResets = [limits.session, limits.weekly, limits.fableWeekly, limits.monthly]
    .filter((window) => window && window.usedPercent >= 100)
    .map((window) => window?.resetsAt)
    .filter((resetsAt): resetsAt is number => typeof resetsAt === 'number')
  if (spentResets.length === 0) {
    return null
  }
  return Math.max(...spentResets)
}
