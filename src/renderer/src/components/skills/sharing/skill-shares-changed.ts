// EP-7: a published or revoked skill link changes the owner's shared links. Every mounted
// "Shared links" list re-reads on this signal, so the count and list are right without reopening
// the page.
const listeners = new Set<() => void>()

/** Someone published or revoked a skill link on this computer. */
export function noteSkillSharesChanged(): void {
  listeners.forEach((listener) => listener())
}

export function onSkillSharesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
