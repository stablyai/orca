import type { AgentCliUpdateRow } from '../status-bar/updates/AgentCliUpdateList'

const STORAGE_KEY = 'orca.agentCliUpdateCard.v1'
// Claude Code and Codex ship several times a week; a card per release would be a daily nag.
export const AGENT_CLI_UPDATE_CARD_INTERVAL_MS = 24 * 60 * 60_000

/** What the user last closed the card on, and when. */
export type AgentCliUpdateCardMemory = {
  closedAt: number
  /** Offer keys listed when it closed; only a version outside these brings the card back. */
  seen: readonly string[]
}

const NO_MEMORY: AgentCliUpdateCardMemory = { closedAt: 0, seen: [] }

/** One CLI release on one host. */
export function agentCliUpdateOfferKey(row: AgentCliUpdateRow): string | null {
  return row.update ? `${row.hostKey}\n${row.agent}\n${row.update.latestVersion}` : null
}

export function readAgentCliUpdateCardMemory(): AgentCliUpdateCardMemory {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'closedAt' in parsed &&
      typeof parsed.closedAt === 'number' &&
      'seen' in parsed &&
      Array.isArray(parsed.seen)
    ) {
      return {
        closedAt: parsed.closedAt,
        seen: parsed.seen.filter((key): key is string => typeof key === 'string')
      }
    }
  } catch {
    // Unreadable storage only means the card may offer again.
  }
  return NO_MEMORY
}

export function writeAgentCliUpdateCardMemory(memory: AgentCliUpdateCardMemory): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory))
  } catch {
    // Unwritable storage only means the card may offer again next launch.
  }
}

/** Milliseconds until the card may offer these releases (0 is now), or null when none is new. */
export function agentCliUpdateCardWait(
  offerKeys: readonly string[],
  memory: AgentCliUpdateCardMemory,
  now: number
): number | null {
  const seen = new Set(memory.seen)
  if (offerKeys.every((key) => seen.has(key))) {
    return null
  }
  // Clamped so a clock set back can't hold the card off for more than a day.
  return Math.min(
    AGENT_CLI_UPDATE_CARD_INTERVAL_MS,
    Math.max(0, memory.closedAt + AGENT_CLI_UPDATE_CARD_INTERVAL_MS - now)
  )
}
