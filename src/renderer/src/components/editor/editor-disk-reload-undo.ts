import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { translate } from '@/i18n/i18n'
import { editorModelSiblingTabs, setEditorDiskBaseline } from './editor-save-disk-precondition'

const RELOAD_UNDO_TOAST_DURATION_MS = 8_000

export type DiscardedReloadDraft = {
  file: OpenFile
  draft: string
  viewIds: readonly string[]
  baseline: string | undefined
  /** The mark Undo restores alongside the draft. */
  restoredMutation: NonNullable<OpenFile['externalMutation']> | null
  onUndo?: () => void
}

/** Offers the discarded draft back while the reloaded record stays clean and untouched. */
export function offerReloadUndo(discarded: DiscardedReloadDraft): void {
  const { file } = discarded
  // Diff reloads destroy model undo history; retain recovery in this toast.
  toast(
    translate('auto.components.editor.ExternalFileChangeBanner.5c02de9b31', 'Reloaded from disk'),
    {
      description: file.relativePath,
      duration: RELOAD_UNDO_TOAST_DURATION_MS,
      action: {
        label: translate('auto.components.editor.ExternalFileChangeBanner.d1e830fa22', 'Undo'),
        onClick: () => {
          const current = useAppStore.getState()
          const liveFile = current.openFiles.find((openFile) => openFile.id === file.id)
          // Undo only for live, clean model siblings, including tabs added since reload. isDirty proves newer work; content sync also populates drafts for clean tabs.
          const modelTabs = liveFile ? editorModelSiblingTabs(current, liveFile) : []
          if (!liveFile || modelTabs.some((tab) => tab.isDirty)) {
            return
          }
          // Tabs that left the model now own independent text and must remain untouched.
          const liveSiblings = modelTabs.filter((tab) => discarded.viewIds.includes(tab.id))
          if (discarded.baseline !== undefined) {
            // Restore the old disk signature so restart scans preserve the conflict alongside the recovered draft.
            setEditorDiskBaseline(current, file.id, discarded.baseline)
          }
          for (const tab of liveSiblings) {
            current.setEditorDraft(tab.id, discarded.draft)
            current.markFileDirty(tab.id, true)
            current.setExternalMutation(tab.id, discarded.restoredMutation)
          }
          discarded.onUndo?.()
        }
      }
    }
  )
}
