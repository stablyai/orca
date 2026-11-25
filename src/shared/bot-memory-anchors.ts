// Where a fact put back into MEMORY.md goes: after the line it followed, never inside a code fence.
import { botMemoryFenceOpeners, insertBotMemoryNonFenceLine } from './bot-memory-fences'

/** The non-blank line a fact followed (null: the top of the file). */
export type BotMemoryAnchor = {
  after: string | null
  /** The anchor's 1-based occurrence among the lines a fact can follow. Older history rows keep
   *  only its text. */
  afterOccurrence?: number
}

/** Whether a fact can come right after line `index`: no fence opener and no line inside a fence,
 *  since the place after either is in the fence. `openers` (botMemoryFenceOpeners) is null for a
 *  file with no fence. */
export function isBotMemoryAnchorLine(openers: readonly number[] | null, index: number): boolean {
  return openers === null || openers[index + 1] === -1
}

/**
 * Puts facts back into `lines`, in place and one by one: after the copy of the line a fact
 * followed; after the last copy for an older row without an occurrence, or when fewer copies are
 * left; at the end when none is; above a fence that place is in.
 */
export function botMemoryPutBack(lines: string[]): (line: string, anchor: BotMemoryAnchor) => void {
  const found = botMemoryFenceOpeners(lines)
  // A fact line is no fence, so a file with none keeps none and needs no tracking.
  const openers = found.some((opener) => opener !== -1) ? found : null
  const counts = new Map<string, number>()
  const count = (index: number): void => {
    const raw = lines[index]
    if (raw.trim() !== '' && isBotMemoryAnchorLine(openers, index)) {
      counts.set(raw, (counts.get(raw) ?? 0) + 1)
    }
  }
  lines.forEach((_raw, index) => count(index))
  const place = ({ after, afterOccurrence }: BotMemoryAnchor): number => {
    if (after === null) {
      return 0
    }
    const copies = counts.get(after) ?? 0
    if (copies === 0) {
      return lines.findLastIndex((raw) => raw.trim() !== '') + 1
    }
    // The same copy counted from both ends at once, so one near either end is found without
    // reading the rest of the file.
    let fromEnd = afterOccurrence === undefined ? 1 : Math.max(1, copies - afterOccurrence + 1)
    let fromStart = copies - fromEnd + 1
    const copy = (index: number): boolean =>
      lines[index] === after && isBotMemoryAnchorLine(openers, index)
    for (let step = 0; step < lines.length; step += 1) {
      if (copy(step) && (fromStart -= 1) === 0) {
        return step + 1
      }
      const back = lines.length - 1 - step
      if (copy(back) && (fromEnd -= 1) === 0) {
        return back + 1
      }
    }
    return lines.length
  }
  return (line, anchor) => {
    const wanted = place(anchor)
    const at = openers === null || openers[wanted] === -1 ? wanted : openers[wanted]
    lines.splice(at, 0, line)
    if (openers !== null) {
      insertBotMemoryNonFenceLine(openers, at)
    }
    count(at)
  }
}
