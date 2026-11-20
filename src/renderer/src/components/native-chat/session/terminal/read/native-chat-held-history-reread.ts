import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatReadSessionResult } from '../../../../../../../preload/api/native-chat/native-chat-api'
import { mergeTranscriptRanges } from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'
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
