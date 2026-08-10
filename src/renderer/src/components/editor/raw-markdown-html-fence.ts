/** Horizontal whitespace only — `^\s*` would cross newlines and open phantom fences (#13307). */
const FENCE_LINE_PATTERN = /^[ \t]*(`{3,}|~{3,})/

export type MarkdownFenceState = {
  activeFence: '`' | '~' | null
  activeFenceLength: number
}

/**
 * If `index` is at a fence delimiter line, toggle fence state and return the
 * exclusive end index of that line (including trailing newline when present).
 * Returns null when this line is not a fence open/close.
 */
export function consumeMarkdownFenceDelimiterLine(
  content: string,
  index: number,
  state: MarkdownFenceState
): number | null {
  const lineRest = content.slice(index)
  const fenceMatch = lineRest.match(FENCE_LINE_PATTERN)
  if (!fenceMatch) {
    return null
  }
  const fenceChar = fenceMatch[1][0] as '`' | '~'
  const fenceLength = fenceMatch[1].length
  if (state.activeFence === null) {
    state.activeFence = fenceChar
    state.activeFenceLength = fenceLength
  } else if (state.activeFence === fenceChar && fenceLength >= state.activeFenceLength) {
    state.activeFence = null
    state.activeFenceLength = 0
  } else {
    return null
  }
  const newlineIndex = content.indexOf('\n', index)
  return newlineIndex === -1 ? content.length : newlineIndex + 1
}
