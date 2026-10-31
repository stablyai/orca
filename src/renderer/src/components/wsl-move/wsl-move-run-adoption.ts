/**
 * A move this window did not start, e.g. after it reloaded mid-move: main keeps running it and only
 * its progress reaches this window. The dialog follows it, and a run that reaches `done` committed,
 * so it gets the same reload prompt as one started here.
 */
import type { WslMoveProgressEvent } from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  getWslMoveDialog,
  refreshWslMoveUnfinished,
  setWslMoveDialog,
  wslMoveDialogLocked
} from './wsl-move-dialog-store'

export function adoptWslMoveProgress(progress: WslMoveProgressEvent): void {
  const dialog = getWslMoveDialog()
  if (dialog.stage === 'running') {
    // A run started here follows its own events; only an adopted one is driven from here.
    if (!dialog.adopted || dialog.distro !== progress.distro) {
      return
    }
    if (progress.result) {
      // It ended without committing; without this the dialog sat on its last step for good.
      setWslMoveDialog({
        stage: 'result',
        distro: dialog.distro,
        selected: [],
        result: progress.result,
        reload: 'idle'
      })
      void refreshWslMoveUnfinished()
      return
    }
    if (progress.step === 'done' && progress.migrationId) {
      setWslMoveDialog({
        stage: 'result',
        distro: dialog.distro,
        selected: [],
        result: {
          outcome: 'moved',
          migrationId: progress.migrationId,
          phase: progress.phase ?? 'destination-committed',
          reloadRequired: true
        },
        reload: 'idle'
      })
      void refreshWslMoveUnfinished()
      return
    }
    setWslMoveDialog({ ...dialog, progress })
    return
  }
  if (
    wslMoveDialogLocked(dialog) ||
    dialog.stage === 'result' ||
    progress.step === 'done' ||
    progress.result
  ) {
    return
  }
  setWslMoveDialog({
    stage: 'running',
    distro: progress.distro,
    selected: [],
    progress,
    cancel: 'idle',
    adopted: true
  })
}
