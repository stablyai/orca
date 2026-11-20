import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../../../../../shared/native-chat/native-chat-agent-support'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { ReadState } from '../../session/terminal/read/native-chat-live-session-contract'

export const NATIVE_CHAT_INITIAL_LIMIT = 300
export const NATIVE_CHAT_PAGE = 200

/** Only applied moves history older; superseded belongs to a newer read generation. */
export type NativeChatOlderPageResult =
  | 'applied'
  | 'exhausted'
  | 'unchanged'
  | 'failed'
  | 'superseded'

export function nextNativeChatLimit(currentLimit: number): number {
  return currentLimit + NATIVE_CHAT_PAGE
}

/** A full window may have older rows; a short read proves exhaustion. */
export function hasMoreNativeChatHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit
}

/** JSONL rows page by record byte start; OpenCode-family routes keep the full reread and its existing depth limits. */
export function nativeChatHistoryCursor(
  agent: AgentType,
  message: NativeChatMessage | undefined
): number | undefined {
  if (!message || resolveNativeChatTranscriptAgent(agent) === 'opencode') {
    return undefined
  }
  const cursor = message.transcriptOrder
  return Number.isSafeInteger(cursor) && cursor! >= 0 ? cursor : undefined
}

/** A re-sent latest window keeps the held older rows when its first row is held, in the base or the live tail, at the same transcript position. */
export function withHeldOlderHistory(
  agent: AgentType,
  held: ReadState,
  liveTail: readonly NativeChatMessage[],
  window: NativeChatMessage[],
  hasOlder: boolean
): NativeChatMessage[] {
  const first = window[0]
  const cursor = nativeChatHistoryCursor(agent, first)
  // A window that proves nothing older exists outranks held rows.
  if (cursor === undefined || held.phase !== 'ready' || !hasOlder) {
    return window
  }
  const heldAt = (rows: readonly NativeChatMessage[]) => {
    const at = rows.findLastIndex((message) => message.id === first!.id)
    return at !== -1 && nativeChatHistoryCursor(agent, rows[at]) === cursor ? at : -1
  }
  const base = held.messages
  const inBase = heldAt(base)
  if (inBase >= 0) {
    return inBase === 0 ? window : [...base.slice(0, inBase), ...window]
  }
  const inTail = heldAt(liveTail)
  if (inTail < 0 || !nativeChatLiveTailJoinsBase(agent, base, liveTail)) {
    return window
  }
  const baseIds = new Set(base.map((message) => message.id))
  const tail = liveTail.slice(0, inTail).filter((message) => !baseIds.has(message.id))
  return [...base, ...tail, ...window]
}

/** A bounded live tail that starts after the held window's last row hides a gap only a full reread repairs. */
export function nativeChatLiveTailJoinsBase(
  agent: AgentType,
  base: readonly NativeChatMessage[],
  liveTail: readonly NativeChatMessage[]
): boolean {
  if (liveTail.length === 0) {
    return true
  }
  const start = nativeChatHistoryCursor(agent, liveTail[0])
  const end = nativeChatHistoryCursor(agent, base.at(-1))
  return start !== undefined && end !== undefined && start <= end
}
