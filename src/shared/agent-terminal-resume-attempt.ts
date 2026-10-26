/** Keep a resume's selected inputs until the execution host gives a known outcome. */
export function createAgentTerminalResumeAttemptRegistry<TAttempt>(
  mintId: (key: string) => string
) {
  const byKey = new Map<string, { id: string; attempt?: TAttempt }>()
  const claim = (key: string): string => {
    const existing = byKey.get(key)
    if (existing) {
      return existing.id
    }
    const id = mintId(key)
    byKey.set(key, { id })
    return id
  }
  return {
    claim,
    freeze(key: string, attempt: TAttempt): { attempt: TAttempt; clientMutationId: string } {
      const clientMutationId = claim(key)
      const entry = byKey.get(key)!
      entry.attempt ??= structuredClone(attempt)
      return { attempt: entry.attempt, clientMutationId }
    },
    releaseOnSuccess(key: string): void {
      byKey.delete(key)
    }
  }
}
