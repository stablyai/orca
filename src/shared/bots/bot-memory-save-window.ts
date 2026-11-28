// When Orca asks a bot chat to save memory before its context fills: once per context window, at
// about 75% or just before the harness compacts on its own, re-armed only by a measured drop.
import {
  contextTokensFromUsage,
  type AgentSessionContextUsage
} from '../agent-session/conversation-context/agent-session-context-usage'

export const BOT_MEMORY_SAVE_WINDOW = {
  /** Share of the window at which a save is due. */
  fraction: 0.75,
  /** Room kept below the harness's own compaction point: the larger of these. */
  reserveTokens: 20_000,
  reserveFraction: 0.05,
  /** A measured drop this far below the save point (as a share of the window) is a new window. */
  rearmFraction: 0.1,
  /** With no known window: a save at this many tokens used, re-armed below the second. */
  unknownWindowSaveAt: 150_000,
  unknownWindowRearmAt: 130_000
} as const

/** What the chat last measured: tokens in use, its window and the harness's compaction point. */
export type BotMemorySaveReading = {
  usedTokens: number
  windowTokens: number | null
  autoCompactAtTokens: number | null
}

/** Null when nothing is measured: then no save is ever proposed. */
export function botMemorySaveReading(usage: AgentSessionContextUsage): BotMemorySaveReading | null {
  const used = usage.used
  if (used?.kind === 'report') {
    return {
      usedTokens: used.usedTokens,
      windowTokens: used.windowTokens > 0 ? used.windowTokens : null,
      autoCompactAtTokens: used.autoCompactAtTokens ?? null
    }
  }
  if (used?.kind === 'estimate') {
    const window = usage.window?.tokens
    return {
      usedTokens: contextTokensFromUsage(used.usage),
      windowTokens: window && window > 0 ? window : null,
      autoCompactAtTokens: null
    }
  }
  return null
}

export type BotMemorySaveThresholds = { saveAt: number; rearmAt: number }

/** saveAt = min(75% of the window, the harness's compaction point less a reserve). */
export function botMemorySaveThresholds(reading: BotMemorySaveReading): BotMemorySaveThresholds {
  const window = reading.windowTokens
  if (window === null) {
    return {
      saveAt: BOT_MEMORY_SAVE_WINDOW.unknownWindowSaveAt,
      rearmAt: BOT_MEMORY_SAVE_WINDOW.unknownWindowRearmAt
    }
  }
  const reserve = Math.max(
    BOT_MEMORY_SAVE_WINDOW.reserveTokens,
    BOT_MEMORY_SAVE_WINDOW.reserveFraction * window
  )
  const saveAt = Math.min(
    BOT_MEMORY_SAVE_WINDOW.fraction * window,
    (reading.autoCompactAtTokens ?? Number.POSITIVE_INFINITY) - reserve
  )
  return { saveAt, rearmAt: saveAt - BOT_MEMORY_SAVE_WINDOW.rearmFraction * window }
}

/** One chat's state: `armed` until an attempt is admitted, then only after a measured drop. */
export type BotMemorySaveWindowState = { armed: boolean }

export type BotMemorySaveStep = {
  /** The state to keep; the same object when nothing changed, so callers write only on change. */
  state: BotMemorySaveWindowState
  /** Usage has reached the save point in an armed window. Idle and pause are the caller's checks. */
  due: boolean
}

/** One measurement. An attempt (whatever its outcome) disarms the window; only a later reading at
 *  or below `rearmAt` arms it again, so a save can never re-arm itself or loop on a shallow
 *  compaction. */
export function botMemorySaveStep(
  state: BotMemorySaveWindowState,
  reading: BotMemorySaveReading
): BotMemorySaveStep {
  const { saveAt, rearmAt } = botMemorySaveThresholds(reading)
  const next = !state.armed && reading.usedTokens <= rearmAt ? { armed: true } : state
  return { state: next, due: next.armed && reading.usedTokens >= saveAt }
}

/** The disarmed state an admitted attempt leaves. */
export const BOT_MEMORY_SAVE_ATTEMPTED: BotMemorySaveWindowState = Object.freeze({ armed: false })
