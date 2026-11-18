import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../../../../../shared/native-chat/native-chat-agent-support'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { OPENCODE_TRANSCRIPT_MAX_WINDOW } from '../../../../../../shared/agent-session/lifecycle/provider-handles/opencode-transcript-page-limit'

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

/** OpenCode-family rows page by provider row id; JSONL rows by record byte start. ZCode ranks are not cursors yet. */
export function nativeChatHistoryCursor(
  agent: AgentType,
  message: NativeChatMessage | undefined
): number | undefined {
  if (!message || agent === 'zcode') {
    return undefined
  }
  const cursor =
    resolveNativeChatTranscriptAgent(agent) === 'opencode'
      ? message.transcriptOffset
      : message.transcriptOrder
  return Number.isSafeInteger(cursor) && cursor! >= 0 ? cursor : undefined
}

/** Hosts that ignore the cursor answer with their newest rows; only a strictly older page is usable. */
export function isNativeChatPageBefore(
  agent: AgentType,
  page: readonly NativeChatMessage[],
  cursor: number
): boolean {
  return page.every((message) => {
    const rowCursor = nativeChatHistoryCursor(agent, message)
    return rowCursor !== undefined && rowCursor < cursor
  })
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

/** Cursor pages keep the depth a route's full reread always stopped at; deeper history waits on depth-independent page assembly. */
export function nativeChatHistoryRowCap(
  agent: AgentType,
  transportCap: number | undefined
): number {
  const providerCap =
    resolveNativeChatTranscriptAgent(agent) === 'opencode'
      ? OPENCODE_TRANSCRIPT_MAX_WINDOW
      : Number.POSITIVE_INFINITY
  return Math.min(transportCap ?? Number.POSITIVE_INFINITY, providerCap)
}
