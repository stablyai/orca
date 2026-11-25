// Where a fact put back into MEMORY.md goes: after the line it followed, never inside a code fence.
import { botMemoryFenceOpeners, insertBotMemoryNonFenceLine } from './bot-memory-fences'

/** The non-blank line a fact followed (null: the top of the file). */
export type BotMemoryAnchor = {
  after: string | null
  /** The anchor's 1-based occurrence among the lines a fact can follow. Older history rows keep
   *  only its text. */
  afterOccurrence?: number
  /** The first line after the fact that stayed: what tells copies of its anchor apart. */
  followedBy?: string
}

/** Whether a fact can come right after line `index`: no fence opener and no line inside a fence,
 *  since the place after either is in the fence. `openers` (botMemoryFenceOpeners) is null for a
 *  file with no fence. */
export function isBotMemoryAnchorLine(openers: readonly number[] | null, index: number): boolean {
  return openers === null || openers[index + 1] === -1
}

/** `anchored`, the lines at `rows[picked[i]]`, each with the first non-blank line after it that
 *  `stays` (followedBy), which tells the copies of its anchor apart when it goes back. */
export function withBotMemoryFollowers<Line extends BotMemoryAnchor>(
  anchored: readonly Line[],
  picked: readonly number[],
  rows: readonly string[],
  stays: (index: number) => boolean
): Line[] {
  const followers = new Map<number, string>()
  let next: string | null = null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (next !== null) {
      followers.set(index, next)
    }
    if (rows[index].trim() !== '' && stays(index)) {
      next = rows[index]
    }
  }
  return anchored.map((line, at) => {
    const followedBy = followers.get(picked[at])
    return line.after === null || followedBy === undefined ? line : { ...line, followedBy }
  })
}

/**
 * Puts facts back into `lines`, in place and one by one, after a copy of the line it followed:
 * the one copy whose part of the file (up to the next copy) still has the line that followed the
 * fact, whatever came or went above or below; when that can't tell (no such line, or it is in more
 * than one copy's part or none), the copy at its occurrence, else the last copy, which is also
 * where an older row without an occurrence goes. At the end when no copy is left; above a fence
 * that place is in.
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
  const isCopy = (index: number, after: string): boolean =>
    lines[index] === after && isBotMemoryAnchorLine(openers, index)
  /** The copy whose part has `followedBy`, when exactly one does. */
  const followed = (after: string, followedBy: string): number | null => {
    let copy = -1
    let found: number | null = null
    for (let index = 0; index < lines.length; index += 1) {
      // Checked first: a fact last in its part is followed by the next copy itself.
      if (copy !== -1 && lines[index] === followedBy) {
        if (found !== null && found !== copy) {
          return null
        }
        found = copy
      }
      if (isCopy(index, after)) {
        copy = index
      }
    }
    return found
  }
  const place = ({ after, afterOccurrence, followedBy }: BotMemoryAnchor): number => {
    if (after === null) {
      return 0
    }
    const copies = counts.get(after) ?? 0
    if (copies === 0) {
      return lines.findLastIndex((raw) => raw.trim() !== '') + 1
    }
    const known = copies > 1 && followedBy !== undefined ? followed(after, followedBy) : null
    if (known !== null) {
      return known + 1
    }
    // The occurrence counted from both ends at once, so a copy near either end is found without
    // reading the rest of the file.
    let fromStart = Math.min(afterOccurrence ?? copies, copies)
    let fromEnd = copies - fromStart + 1
    for (let step = 0; step < lines.length; step += 1) {
      if (isCopy(step, after) && (fromStart -= 1) === 0) {
        return step + 1
      }
      const back = lines.length - 1 - step
      if (isCopy(back, after) && (fromEnd -= 1) === 0) {
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
