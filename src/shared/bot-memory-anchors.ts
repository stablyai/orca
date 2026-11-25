// Where a fact put back into MEMORY.md goes: after the line it followed, never inside a code fence.
import { botMemoryFenceOpeners, insertBotMemoryNonFenceLine } from './bot-memory-fences'

/** Whether a fact can come right after line `index`: no fence opener and no line inside a fence,
 *  since the place after either is in the fence. `openers` (botMemoryFenceOpeners) is null for a
 *  file with no fence. */
function isAnchorLine(openers: readonly number[] | null, index: number): boolean {
  return openers === null || openers[index + 1] === -1
}

/**
 * Puts facts back into `lines`, in place and one by one: after the last copy of the line it
 * followed (`after`; null: the top) that is no fence opener and no line inside a fence, else at
 * the end; above a fence that place is in.
 */
export function botMemoryPutBack(lines: string[]): (line: string, after: string | null) => void {
  const found = botMemoryFenceOpeners(lines)
  // A fact line is no fence, so a file with none keeps none and needs no tracking.
  const openers = found.some((opener) => opener !== -1) ? found : null
  const place = (after: string | null): number => {
    if (after === null) {
      return 0
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] === after && isAnchorLine(openers, index)) {
        return index + 1
      }
    }
    return lines.findLastIndex((raw) => raw.trim() !== '') + 1
  }
  return (line, after) => {
    const wanted = place(after)
    const at = openers === null || openers[wanted] === -1 ? wanted : openers[wanted]
    lines.splice(at, 0, line)
    if (openers !== null) {
      insertBotMemoryNonFenceLine(openers, at)
    }
  }
}
