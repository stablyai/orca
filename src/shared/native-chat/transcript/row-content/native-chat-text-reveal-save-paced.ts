import { nextStreamedTextCheckpointLength } from '../../../agent-session/journal/streamed-text-checkpoint-growth'
import type { NativeChatTextReveal } from './native-chat-text-reveal'

/** However slowly a reply renders, it still moves at least this often. */
export const NATIVE_CHAT_REVEAL_MAX_STEP_MS = 6000
const MAX_STEP_MS = NATIVE_CHAT_REVEAL_MAX_STEP_MS

/** A reply shown only where a save would show it: everything received so far now, then the newest
 *  text each time it grows past the next save's length or has waited the longest a step may, and all
 *  of it at its end. No reveal runs. */
export function savePacedNativeChatText(
  previous: NativeChatTextReveal,
  now: number,
  savedRevision?: number
): NativeChatTextReveal {
  return savePacedAt(previous.source, now, savedRevision)
}

function savePacedAt(
  source: string,
  now: number,
  savedRevision: number | undefined
): NativeChatTextReveal {
  return {
    source,
    shown: source.length,
    arrivals: [],
    savePaced: true,
    shownAt: now,
    ...(savedRevision === undefined ? {} : { savedRevision })
  }
}

/** When a save-paced reply must show the `text` it is holding back, or undefined if it holds none. */
export function savePacedNativeChatTextDue(
  reveal: NativeChatTextReveal,
  text: string
): number | undefined {
  return reveal.savePaced && text.length > reveal.source.length && text.startsWith(reveal.source)
    ? (reveal.shownAt ?? 0) + MAX_STEP_MS
    : undefined
}

export function receiveSavePacedText(
  previous: NativeChatTextReveal,
  text: string,
  streaming: boolean,
  immediate: boolean,
  now: number,
  savedRevision: number | undefined
): NativeChatTextReveal {
  const shownLength = previous.source.length
  // A known revision says when the host saved; without one, a save is due at the next growth step.
  const saved =
    savedRevision === undefined
      ? text.length >= nextStreamedTextCheckpointLength(shownLength)
      : savedRevision !== previous.savedRevision
  const due =
    immediate ||
    !streaming ||
    !text.startsWith(previous.source) ||
    shownLength === 0 ||
    saved ||
    now - (previous.shownAt ?? -Infinity) >= MAX_STEP_MS
  if (!due) {
    return previous
  }
  return text !== previous.source
    ? savePacedAt(text, now, savedRevision)
    : savedRevision === undefined || savedRevision === previous.savedRevision
      ? previous
      : { ...previous, savedRevision }
}
