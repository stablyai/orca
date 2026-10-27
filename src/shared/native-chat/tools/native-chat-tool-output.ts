import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody
} from '../../agent-session-journal-types'
import { formatBytes } from '../../format-bytes'
import type { NativeChatToolResultBlock } from '../../native-chat-types'
import { MAX_TOOL_DETAIL_LENGTH } from './native-chat-tool-summary'

export const NATIVE_CHAT_TOOL_OUTPUT_COPY = {
  partial: 'Showing {{shown}} of {{total}}.'
} as const

/** The full payload a tool row's detail read returns, if the item carries one. */
export function nativeChatToolFullPayload(
  body: AgentJournalItemBody | null | undefined
): AgentJournalBoundedPayload | null {
  if (body?.kind === 'tool-call') {
    return body.output ?? null
  }
  return body?.kind === 'diff' ? body.patch : null
}

/** Host-held output always offers "Show full output"; inline output only while it is cut. */
export function isNativeChatToolOutputClipped(
  body: NativeChatToolResultBlock,
  view: { expanded: boolean; fullLoaded: boolean }
): boolean {
  return (
    !view.fullLoaded &&
    (body.fullOutputItemId !== undefined ||
      (!view.expanded && body.output.length > MAX_TOOL_DETAIL_LENGTH))
  )
}

/** A partial detail response keeps the original byte count; null when the payload is whole. */
export function nativeChatToolOutputPartialSizes(
  payload: AgentJournalBoundedPayload
): { shown: string; total: string } | null {
  return payload.truncated
    ? {
        shown: formatBytes(new TextEncoder().encode(payload.head).length),
        total: formatBytes(payload.byteLength)
      }
    : null
}
