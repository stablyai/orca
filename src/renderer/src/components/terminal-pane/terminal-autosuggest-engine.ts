/** Most-recent-first prefix match; candidates[0] is treated as most recent. */
export function bestAutosuggestMatch(
  candidates: readonly string[],
  currentInput: string
): string | null {
  if (currentInput.length === 0) {
    return null
  }
  for (const candidate of candidates) {
    if (candidate === currentInput) {
      continue
    }
    if (candidate.startsWith(currentInput)) {
      return candidate
    }
  }
  return null
}
