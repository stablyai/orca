import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppState } from '@/store/types'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'

/** New view id → model URI it was renamed from, until that view's editor mounts. */
const renamedModelUriByViewId = new Map<string, string>()

/**
 * A rename gives a tab a new id and path, which remounts its editor on a new model. Record the
 * old model so the remount carries the buffer's model state instead of rebuilding it from text.
 */
export function handOffRenamedEditorModels(
  state: Pick<AppState, 'openFiles'> & Parameters<typeof getEditorModelOwnerKey>[1],
  rekeys: readonly { oldFileId: string; newFileId: string }[]
): void {
  const files = new Map<string, OpenFile>(state.openFiles.map((file) => [file.id, file]))
  const handoffs = rekeys.flatMap(({ oldFileId, newFileId }) => {
    const file = files.get(oldFileId)
    if (file?.mode !== 'edit') {
      return []
    }
    // A tab renamed again before it mounted still points at the first model.
    const fromUri =
      renamedModelUriByViewId.get(oldFileId) ??
      toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state))
    return [{ oldFileId, newFileId, fromUri }]
  })
  // Why two passes: a swap of two ids must not delete the entry it just wrote.
  for (const { oldFileId } of handoffs) {
    renamedModelUriByViewId.delete(oldFileId)
  }
  for (const { newFileId, fromUri } of handoffs) {
    renamedModelUriByViewId.set(newFileId, fromUri)
  }
}

export function takeRenamedEditorModelUri(viewId: string): string | undefined {
  const fromUri = renamedModelUriByViewId.get(viewId)
  renamedModelUriByViewId.delete(viewId)
  return fromUri
}
