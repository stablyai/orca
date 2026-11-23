import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatReadSessionResult } from '../../../../../../../preload/api/native-chat/native-chat-api'
import { mergeTranscriptRanges } from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  nativeChatHistoryCursor,
  nativeChatLiveTailJoinsBase
} from '../../../viewport/history/native-chat-pagination'
import type { ReadState } from './native-chat-live-session-contract'
import type { NativeChatSessionTransport } from './native-chat-session-transport'

export async function rereadNativeChatHeldHistory(
  transport: NativeChatSessionTransport,
  agent: AgentType,
  sessionId: string,
  transcriptPath: string | undefined,
  depth: number,
  limit: number,
  signal: AbortSignal
): Promise<NativeChatReadSessionResult> {
  const requested = Math.max(depth, limit)
  const pages: Extract<NativeChatReadSessionResult, { messages: unknown }>[] = []
  const ids = new Set<string>()
  let beforeOffset: number | undefined
  let hasMore = true
  while (hasMore) {
    signal.throwIfAborted()
    const page = await transport.readSession(
      agent,
      sessionId,
      requested,
      transcriptPath,
      beforeOffset === undefined ? undefined : { beforeOffset }
    )
    signal.throwIfAborted()
    if ('error' in page) {
      throw new Error(page.error)
    }
    pages.push(page)
    for (const message of page.messages) {
      ids.add(message.id)
    }
    hasMore = page.hasMore ?? page.messages.length >= requested
    if (ids.size >= depth || !hasMore) {
      break
    }
    const cursor = page.messages[0]?.transcriptOrder
    if (cursor === undefined || (beforeOffset !== undefined && cursor >= beforeOffset)) {
      throw new Error('Transcript history cursor did not advance')
    }
    beforeOffset = cursor
  }
  const seen = new Set<string>()
  return {
    ...pages[0],
    messages: pages.toReversed().flatMap((page) =>
      page.messages.filter((message) => {
        if (seen.has(message.id)) {
          return false
        }
        seen.add(message.id)
        return true
      })
    ),
    ranges: mergeTranscriptRanges(pages.flatMap((page) => page.ranges ?? [])),
    hasMore,
    beforeOffset: pages.at(-1)?.messages[0]?.transcriptOrder
  }
}

/** A window that landed during the re-read keeps its rows; the re-read supplies only the rows older than it. */
export function spliceHeldHistoryReread(
  agent: AgentType,
  reread: readonly NativeChatMessage[],
  held: ReadState,
  windowFirst: NativeChatMessage | undefined
): NativeChatMessage[] | undefined {
  const start = nativeChatHistoryCursor(agent, windowFirst)
  const at =
    held.phase === 'ready' && windowFirst
      ? held.messages.findIndex((message) => message.id === windowFirst.id)
      : -1
  const end = nativeChatHistoryCursor(agent, reread.at(-1))
  // Rows appended past the re-read's end leave a gap only another re-read fills.
  if (held.phase !== 'ready' || start === undefined || at < 0 || end === undefined || end < start) {
    return undefined
  }
  // A page loaded during the re-read holds rows older than it reached; only a deeper re-read keeps them.
  const heldFirst = nativeChatHistoryCursor(agent, held.messages[0])
  const rereadFirst = nativeChatHistoryCursor(agent, reread[0])
  if (at > 0 && heldFirst !== undefined && rereadFirst !== undefined && heldFirst < rereadFirst) {
    return undefined
  }
  return [
    ...reread.filter((message) => {
      const cursor = nativeChatHistoryCursor(agent, message)
      return cursor !== undefined && cursor < start
    }),
    ...held.messages.slice(at)
  ]
}

/** Held base rows plus live-tail rows the base doesn't already hold. */
export function heldNativeChatHistoryDepth(
  held: ReadState,
  liveTail: readonly NativeChatMessage[]
): number {
  const messages = held.phase === 'ready' ? held.messages : []
  const ids = new Set(messages.map((message) => message.id))
  return messages.length + liveTail.filter((message) => !ids.has(message.id)).length
}

/** The repaired base, or undefined when appends during the re-read left a gap only another re-read fills. */
export function heldHistoryRereadBase(
  agent: AgentType,
  reread: readonly NativeChatMessage[],
  superseded: boolean,
  current: {
    held: ReadState
    windowFirst: NativeChatMessage | undefined
    liveTail: readonly NativeChatMessage[]
  }
): NativeChatMessage[] | undefined {
  const base = superseded
    ? spliceHeldHistoryReread(agent, reread, current.held, current.windowFirst)
    : [...reread]
  return base && nativeChatLiveTailJoinsBase(agent, base, current.liveTail) ? base : undefined
}
