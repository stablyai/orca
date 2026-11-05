/** Leaving the dialog: closing, or hiding what must not be lost, and the reload after a move. */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { requestLazyChunkRecoveryReload } from '@/lib/lazy-chunk-recovery-reload'
import {
  getWslMoveDialog,
  invalidateWslMovePreviews,
  mustReload,
  setWslMoveDialog,
  wslMoveDialogLocked
} from './wsl-move-dialog-store'

/** Reload through restart preparation, which backs up unsaved editors first. */
export async function reloadAfterWslMove(): Promise<void> {
  const dialog = getWslMoveDialog()
  if (dialog.stage !== 'result' || dialog.reload === 'reloading') {
    return
  }
  setWslMoveDialog({ ...dialog, reload: 'reloading' })
  // Resolves only when the reload was refused; a landed reload replaces this document.
  const outcome = await requestLazyChunkRecoveryReload(window)
  const now = getWslMoveDialog()
  if (now.stage === 'result') {
    setWslMoveDialog({ ...now, reload: outcome })
  }
}

/**
 * Close, or hide what must not be lost: a running move shows again with its result, and a
 * moved window whose reload was refused keeps a toast that offers the reload.
 */
export function closeWslMoveDialog(): void {
  const dialog = getWslMoveDialog()
  if (dialog.stage === 'running') {
    setWslMoveDialog({ ...dialog, hidden: true })
    return
  }
  if (wslMoveDialogLocked(dialog)) {
    return
  }
  if (dialog.stage === 'result' && mustReload(dialog.result)) {
    setWslMoveDialog({ ...dialog, hidden: true })
    toast(translate('wslMove.reloadToast.title', 'Reload to finish the move'), {
      id: 'wsl-move-reload',
      duration: Infinity,
      action: {
        label: translate('wslMove.result.reload', 'Reload now'),
        onClick: () => {
          const now = getWslMoveDialog()
          if (now.stage === 'result') {
            setWslMoveDialog({ ...now, hidden: false, reload: 'idle' })
            void reloadAfterWslMove()
          }
        }
      }
    })
    return
  }
  invalidateWslMovePreviews()
  setWslMoveDialog({ stage: 'closed' })
}
