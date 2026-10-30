import type { CustomEditorBinaryDocument } from './plugin-custom-editor-host'

/**
 * A binary custom editor's bytes last read or saved, and the unsaved edit. Kept apart from the
 * text drafts so a text save can never write bytes as text; not kept across restarts.
 */
export type BytesDocument = {
  saved: CustomEditorBinaryDocument
  savedSha256: string
  draft: CustomEditorBinaryDocument | null
}

// Why a shared box: tabs of one file share one dirty flag, so they must share one draft too.
// `edits` counts edits and saves, so a read that started before one can be told apart.
export type BytesDocumentBox = { current: BytesDocument; edits: number }

/** Per tab id. Its own module so the store's rename can move entries without importing the store. */
export const bytesDocumentBoxes = new Map<string, BytesDocumentBox>()

/** A rename gives tabs new ids; their bytes, unsaved edits included, move with them. */
export function rekeyEditorBytesDocuments(
  rekeys: readonly { oldFileId: string; newFileId: string }[]
): void {
  const moved = rekeys.flatMap(({ oldFileId, newFileId }) => {
    const box = bytesDocumentBoxes.get(oldFileId)
    return box ? [{ oldFileId, newFileId, box }] : []
  })
  // Why two passes: a swap of two ids must not delete the entry it just wrote.
  for (const { oldFileId } of moved) {
    bytesDocumentBoxes.delete(oldFileId)
  }
  for (const { newFileId, box } of moved) {
    bytesDocumentBoxes.set(newFileId, box)
  }
}
