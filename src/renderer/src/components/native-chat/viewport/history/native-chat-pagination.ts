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

/** A re-sent latest window keeps the held older rows when its first row is held at the same transcript position. */
export function withHeldOlderHistory(
  agent: AgentType,
  held: ReadState,
  window: NativeChatMessage[]
): NativeChatMessage[] {
  const first = window[0]
  const cursor = nativeChatHistoryCursor(agent, first)
  if (cursor === undefined || held.phase !== 'ready') {
    return window
  }
  const at = held.messages.findIndex((message) => message.id === first!.id)
  if (at <= 0 || nativeChatHistoryCursor(agent, held.messages[at]) !== cursor) {
    return window
  }
  return [...held.messages.slice(0, at), ...window]
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
