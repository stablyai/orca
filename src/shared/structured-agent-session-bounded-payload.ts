import type { NativeChatClippedPayload } from './native-chat-types'

/** What the journal kept of an oversized payload, and what the whole one was. */
type BoundedPayload = {
  head: string
  truncated: boolean
  byteLength: number
  digest: string
  retrievable?: boolean
}

export function boundedText(
  payload: Pick<BoundedPayload, 'head' | 'truncated' | 'byteLength'>
): string {
  return payload.truncated ? `${payload.head}\n… (${payload.byteLength} bytes)` : payload.head
}

/** The structured reference a truncated payload carries beside its marker, so a
 *  renderer can offer the complete original when the host retained it. */
export function clippedReference(
  payload: Omit<BoundedPayload, 'head'>
): { clipped: NativeChatClippedPayload } | Record<string, never> {
  return payload.truncated
    ? {
        clipped: {
          digest: payload.digest,
          byteLength: payload.byteLength,
          retrievable: payload.retrievable === true
        }
      }
    : {}
}

/** The markers a clipped payload carries in its own text, anchored to the end
 *  so nothing that merely looks like one inside the body can match. */
const BOUNDED_TEXT_MARKERS = [
  /\n… \(\d+ bytes\)$/,
  /\n\[Orca: output truncated — \d+ bytes total, digest [0-9a-f]+\]$/
]

/** Recovers the clipped body from a bounded payload's text, and says whether a
 *  marker was there. A reader that treats the text as content renders the
 *  marker as a line of it — with a line number, which reads as a real position
 *  in the file — and reports the body as complete. */
export function stripBoundedTextMarker(text: string): { text: string; truncated: boolean } {
  const stripped = BOUNDED_TEXT_MARKERS.reduce((value, marker) => value.replace(marker, ''), text)
  return { text: stripped, truncated: stripped.length !== text.length }
}
