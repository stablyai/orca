// Context usage a chat surface can derive from the transcript alone: the prompt
// the model read on the last request that reported usage, against the window of
// the model that served it.

import type { NativeChatMessage, NativeChatTokenUsage } from './native-chat-types'

export type NativeChatContextUsage = {
  usedTokens: number
  /** Null when the serving model's window is not known. */
  windowTokens: number | null
  /** Rounded and never clamped: an over-limit turn reads above 100. Null with the window. */
  percentage: number | null
}

/** Resolves a model's context window, or null when the host does not know it. */
export type NativeChatContextWindowLookup = (message: NativeChatMessage) => number | null

/** Everything the model read on the request, which is what fills the window. */
function contextTokensFromUsage(usage: NativeChatTokenUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
}

/** True for the transcript row an agent writes when it compacts the conversation. */
export function isNativeChatCompactionBoundary(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some((block) => block.type === 'text' && block.presentation === 'compaction')
  )
}

/** The newest usage-bearing response decides; a compaction after it means the
 *  context it measured is gone, so nothing is known until the next response. */
export function deriveNativeChatContextUsage(
  messages: readonly NativeChatMessage[],
  windowFor: NativeChatContextWindowLookup
): NativeChatContextUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (isNativeChatCompactionBoundary(message)) {
      return null
    }
    if (message.role !== 'assistant' || !message.usage) {
      continue
    }
    const usedTokens = contextTokensFromUsage(message.usage)
    if (usedTokens <= 0) {
      return null
    }
    const window = windowFor(message)
    const windowTokens = window !== null && window > 0 ? window : null
    return {
      usedTokens,
      windowTokens,
      percentage: windowTokens === null ? null : Math.round((usedTokens / windowTokens) * 100)
    }
  }
  return null
}

/** `18.6k`, `1m`, `981.4k` — the compact notation agent CLIs print. */
export function formatContextTokenCount(tokens: number): string {
  const safe = Math.max(0, tokens)
  if (safe >= 1_000_000) {
    return `${trimZero((safe / 1_000_000).toFixed(1))}m`
  }
  if (safe >= 1_000) {
    return `${trimZero((safe / 1_000).toFixed(1))}k`
  }
  return String(Math.round(safe))
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
