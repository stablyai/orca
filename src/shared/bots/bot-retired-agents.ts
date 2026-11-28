import type { BotAgent } from '../bot-types'

/** Agents a saved or shared bot can still name after Orca dropped them. */
export const BOT_RETIRED_AGENTS = ['gemini'] as const
export type BotRetiredAgent = (typeof BOT_RETIRED_AGENTS)[number]

/** The agent each retired one's bots now run on. */
export const BOT_AGENT_SUCCESSORS: Record<BotRetiredAgent, BotAgent> = { gemini: 'antigravity' }

export function isBotRetiredAgent(agent: unknown): agent is BotRetiredAgent {
  return BOT_RETIRED_AGENTS.some((entry) => entry === agent)
}

/** A saved bot record on a retired agent, moved to its successor; its launch belonged to the old agent. */
export function migrateRetiredBotAgent(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null || !('agent' in candidate)) {
    return candidate
  }
  if (!isBotRetiredAgent(candidate.agent)) {
    return candidate
  }
  const { launch: _retiredLaunch, ...rest }: { agent: unknown; launch?: unknown } = candidate
  return { ...rest, agent: BOT_AGENT_SUCCESSORS[candidate.agent] }
}
