// Why: a chunked paste holds back the draft until its last chunk lands, so a save in between
// would write text the model no longer shows. Keyed by Monaco model URI, which tabs share.
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
