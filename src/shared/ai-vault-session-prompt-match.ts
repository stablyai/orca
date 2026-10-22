export function normalizeSessionPrompt(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? ''
}

export function sessionPromptsMatch(sessionText: string, candidateText: string): boolean {
  if (!sessionText || !candidateText) {
    return false
  }
  return (
    sessionText === candidateText ||
    (sessionText.length >= 24 &&
      candidateText.length >= 24 &&
      (sessionText.startsWith(candidateText) || candidateText.startsWith(sessionText)))
  )
}

export function agentEntryPromptCandidates(entry: {
  prompt?: string
  stateHistory?: readonly { prompt: string }[]
}): string[] {
  return [
    ...new Set(
      [entry.prompt, ...(entry.stateHistory ?? []).map((history) => history.prompt)]
        .map(normalizeSessionPrompt)
        .filter(Boolean)
    )
  ]
}
