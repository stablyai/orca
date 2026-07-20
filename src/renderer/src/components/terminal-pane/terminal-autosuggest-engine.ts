/** Most-recent-first prefix match; candidates[candidates.length - 1] is treated as most recent. */
export function bestAutosuggestMatch(
  candidates: readonly string[],
  currentInput: string
): string | null {
  if (currentInput.length === 0) {
    return null
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]
    if (candidate === currentInput) {
      continue
    }
    if (candidate.startsWith(currentInput)) {
      return candidate
    }
  }
  return null
}
