import { imageReferenceToken } from '../../../../../../shared/native-chat/attachments/native-chat-image-reference'

// What a hand-off itself does to the message's words, around its own chips only:
// - a chip inserted at the caret gets a space on either side only where there isn't one already;
// - a chip added after the draft (the message box has no editor taking input) goes after a blank
//   line, with the draft's trailing whitespace trimmed;
// - a replaced chip goes with the space after it.
// So each of this hand-off's chips, with or without a space on either side (or, at the end, with
// the whitespace before it), is the hand-off's own; every other character must be as it was.

/** Past this many readings the words are taken as changed: Send stages instead of sending. */
const MAX_READINGS = 256

/** The text without the first `token`, in each way the hand-off may have spaced it. */
function withoutToken(text: string, token: string): string[] {
  const at = text.indexOf(token)
  if (at === -1) {
    return [text]
  }
  const before = text.slice(0, at)
  const after = text.slice(at + token.length)
  const leads = before.endsWith(' ') ? [before, before.slice(0, -1)] : [before]
  const trails = after.startsWith(' ') ? [after, after.slice(1)] : [after]
  const readings = leads.flatMap((lead) => trails.map((trail) => lead + trail))
  if (after.trim() === '') {
    readings.push(before.trimEnd())
  }
  return readings
}

function readingsWithout(text: string, tokens: readonly string[]): Set<string> | null {
  let readings = new Set([text])
  for (const token of tokens) {
    const next = new Set<string>()
    for (const reading of readings) {
      for (const result of withoutToken(reading, token)) {
        next.add(result)
      }
    }
    if (next.size > MAX_READINGS) {
      return null
    }
    readings = next
  }
  return readings
}

/** Whether the message's words now are the ones Send was pressed on, apart from this hand-off's
 *  own chips: the marked copies it added and the chip they replaced. */
export function nativeChatNotesSendWordsUnchanged(
  approved: string,
  now: string,
  ids: readonly string[],
  replacedId: string | undefined
): boolean {
  const replaced = replacedId ? [imageReferenceToken(replacedId)] : []
  const then = readingsWithout(approved, replaced)
  const current = readingsWithout(now, [...ids.map(imageReferenceToken), ...replaced])
  if (!then || !current) {
    return false
  }
  // A chip appended after the draft trimmed the whitespace the draft ended with.
  // A copy: the loop adds to `then`.
  for (const reading of Array.from(then)) {
    then.add(reading.trimEnd())
  }
  return [...current].some((reading) => then.has(reading))
}
