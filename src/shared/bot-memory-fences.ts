// Code fences in MEMORY.md: a line inside one reads as code, never as a fact, whatever it looks like.

export const BOT_MEMORY_FENCE = /^\s*(`{3,}|~{3,})/

/** For each place between lines (0: above the first, `lines.length`: below the last), the line
 *  opening the code fence that place is in, or -1: a line put there in a fence reads as code. */
export function botMemoryFenceOpeners(lines: readonly string[]): number[] {
  // The open fence, if any: it closes only on the same character at least as many times.
  let open: { fence: string; line: number } | null = null
  const openers = [-1]
  lines.forEach((raw, line) => {
    const fence = BOT_MEMORY_FENCE.exec(raw)?.[1]
    if (fence && open === null) {
      open = { fence, line }
    } else if (
      // A closer is the same character, at least as long, with nothing but spaces after it.
      fence &&
      open !== null &&
      fence[0] === open.fence[0] &&
      fence.length >= open.fence.length &&
      raw.trim() === fence
    ) {
      open = null
    }
    openers.push(open?.line ?? -1)
  })
  return openers
}

/** `openers` (botMemoryFenceOpeners) kept right after a line that is no fence goes in at `at`, a
 *  place in no fence: the places after it move down one, and so does each fence line they name,
 *  all of which come after `at`. */
export function insertBotMemoryNonFenceLine(openers: number[], at: number): void {
  openers.splice(at + 1, 0, -1)
  for (let index = at + 2; index < openers.length; index += 1) {
    openers[index] += openers[index] === -1 ? 0 : 1
  }
}
