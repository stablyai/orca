export type EditorDiscardGeneration = { discarded: boolean }

// Pending work owns the generation; these weak lookups only let Don't Save reach it.
function generationLookup() {
  const generations = new Map<string, WeakRef<EditorDiscardGeneration>>()
  const finalized = new FinalizationRegistry<{
    key: string
    reference: WeakRef<EditorDiscardGeneration>
  }>(({ key, reference }) => {
    if (generations.get(key) === reference) {
      generations.delete(key)
    }
  })
  return {
    capture(key: string): EditorDiscardGeneration {
      const current = generations.get(key)?.deref()
      if (current) {
        return current
      }
      const generation = { discarded: false }
      const reference = new WeakRef(generation)
      generations.set(key, reference)
      finalized.register(generation, { key, reference })
      return generation
    },
    discard(key: string): void {
      const current = generations.get(key)?.deref()
      if (current) {
        current.discarded = true
      }
      generations.delete(key)
    }
  }
}

const saves = generationLookup()
const viewEdits = generationLookup()

export function captureEditorDiscardGeneration(recordId: string): EditorDiscardGeneration {
  return saves.capture(recordId)
}

export function captureEditorViewEditGeneration(viewId: string): EditorDiscardGeneration {
  return viewEdits.capture(viewId)
}

/** "Don't Save": every operation captured before this writes nothing. */
export function discardEditorGenerations(recordId: string, viewIds: readonly string[]): void {
  saves.discard(recordId)
  for (const viewId of viewIds) {
    viewEdits.discard(viewId)
  }
}

/** Thrown before sending a save that a discard voided while it waited on the host. */
export class EditorSaveDiscardedError extends Error {
  constructor() {
    super('The edits were discarded before the save was sent.')
  }
}
