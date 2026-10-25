import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { editorDiscardEpoch } from './editor-discard-epoch'

/** Snapshot when a delayed view edit starts; a Discard since then drops the edit silently. */
export function staleViewEditEpoch(fileId: string): number {
  return editorDiscardEpoch(editorBufferIdOfView(useAppStore.getState(), fileId))
}

/** Focus moved outside the view, e.g. into another view of the same file, so its delayed edit must commit now. */
export function focusLeftView(event: {
  currentTarget: Element
  relatedTarget: EventTarget | null
}): boolean {
  const next = event.relatedTarget
  return !(next instanceof Node && event.currentTarget.contains(next))
}

/** A delayed view edit was dropped because the shared text changed after the edit began. */
export function notifyStaleViewEditRejected(fileId: string, editEpoch: number): void {
  if (staleViewEditEpoch(fileId) !== editEpoch) {
    return
  }
  toast.error(
    translate(
      'auto.components.editor.staleViewEdit.rejected',
      'Recent typing in this view was discarded because the file changed in another view.'
    ),
    { id: 'editor-stale-view-edit' }
  )
}
