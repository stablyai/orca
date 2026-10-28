// Chunked pastes publish drafts only at completion; hold saves across every tab sharing the model URI to avoid writing outdated text.
const pastesInFlight = new Map<string, number>()

export function beginEditorLargePaste(modelUri: string): () => void {
  pastesInFlight.set(modelUri, (pastesInFlight.get(modelUri) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) {
      return
    }
    ended = true
    const remaining = (pastesInFlight.get(modelUri) ?? 1) - 1
    if (remaining > 0) {
      pastesInFlight.set(modelUri, remaining)
    } else {
      pastesInFlight.delete(modelUri)
    }
  }
}

export function isEditorLargePasteInFlight(modelUri: string): boolean {
  return pastesInFlight.has(modelUri)
}
