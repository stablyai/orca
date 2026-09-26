type SaveObservation = { writes: Set<Promise<void>>; failure?: { error: unknown } }

/** Associate existing writes with callers independently of path-derived editor IDs. */
export function createExternalEditorSaveWaits() {
  const pending = new Map<string, SaveObservation>()

  /** Repeated store notifications must not attach duplicate settlement handlers. */
  const track = (requestIds: readonly string[] | undefined, save: Promise<void>): void => {
    for (const requestId of requestIds ?? []) {
      const observation: SaveObservation = pending.get(requestId) ?? { writes: new Set() }
      const { writes } = observation
      if (writes.has(save)) {
        continue
      }
      pending.set(requestId, observation)
      writes.add(save)
      const settled = (): void => {
        writes.delete(save)
      }
      void save.then(settled, (error: unknown) => {
        // Retain failures until release, even if settlement precedes the close event.
        observation.failure ??= { error }
        settled()
      })
    }
  }

  /** Include writes admitted during an earlier drain without following a reused file ID. */
  const wait = async (requestId: string): Promise<void> => {
    const observation = pending.get(requestId)
    if (!observation) {
      return
    }
    while (pending.get(requestId) === observation && observation.writes.size > 0) {
      await Promise.allSettled(observation.writes)
    }
    if (pending.get(requestId) === observation && observation.failure) {
      throw observation.failure.error
    }
  }

  return {
    track,
    wait,
    /** Cancel observation without cancelling writes shared with another caller. */
    release: (requestId: string): void => {
      pending.delete(requestId)
    },
    /** The save controller owns these observations only for its own lifetime. */
    clear: (): void => pending.clear()
  }
}
