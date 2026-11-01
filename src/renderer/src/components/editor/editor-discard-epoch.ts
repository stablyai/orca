// Keyed by buffer record. Dirty state can be republished after a discard, so saves compare this.
const epochs = new Map<string, number>()

export function editorDiscardEpoch(recordId: string): number {
  return epochs.get(recordId) ?? 0
}

/** "Don't Save": every save requested before this writes nothing. */
export function bumpEditorDiscardEpoch(recordId: string): void {
  epochs.set(recordId, editorDiscardEpoch(recordId) + 1)
}

/** Thrown before sending a save that a discard voided while it waited on the host. */
export class EditorSaveDiscardedError extends Error {
  constructor() {
    super('The edits were discarded before the save was sent.')
  }
}
