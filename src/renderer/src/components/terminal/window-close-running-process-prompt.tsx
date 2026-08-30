import { useCallback, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import {
  abandonWindowCloseRequest,
  getWindowCloseRequestSeq,
  runWithWindowCloseCheckpointScope
} from '../window-close-request-coordinator'
import { anyLocalPtyBlocksWindowClose } from './window-close-running-process-evidence'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'

export type WindowCloseRunningProcessPrompt = {
  /** Probes the window's local PTYs, then either raises the confirmation or closes. */
  proceedToNativeWindowClose: (isQuitting: boolean) => void
  windowCloseDialog: ReactElement
}

/**
 * The window-close confirmation, shown for local terminals with running children
 * (SSH terminals detach/persist via the relay). Owns the probe, the decision and
 * the dialog together so the decision is only ever reachable through the surface
 * the user actually sees.
 */
export function useWindowCloseRunningProcessPrompt(): WindowCloseRunningProcessPrompt {
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)

  /** Ends the current attempt. Why abandon and not just close the dialog: the newest
   *  attempt is not the newest intent — a probe still outstanding when the user
   *  dismisses belongs to a close they have since called off, and letting it
   *  decide closes the window they just chose to keep. */
  const dismissWindowCloseDialog = useCallback(() => {
    abandonWindowCloseRequest()
    setWindowCloseDialogOpen(false)
  }, [])

  const confirmNativeWindowClose = useCallback(() => {
    // Why: capture only after every close guard has committed. A canceled child-
    // process prompt must not consume App's synthetic/native unload guard.
    const accepted = runWithWindowCloseCheckpointScope(() =>
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    )
    if (!accepted) {
      // Why: a checkpoint-vetoed quit used to die here with no dialog and no log,
      // leaving SIGKILL as the only exit (#15352). The dirty-file veto publishes
      // no reason — its deferred dialog flow already gives the user a surface.
      showShutdownCheckpointFailureToast()
      return
    }
    window.api.ui.confirmWindowClose()
  }, [])

  const proceedToNativeWindowClose = useCallback(
    (isQuitting: boolean) => {
      // Why read the coordinator's id rather than count attempts here: most close
      // requests never reach this function — a pre-close guard can veto one, and
      // Terminal defers one behind the unsaved-changes dialog — yet each of those
      // still supersedes the attempt before it. Counting only the probing calls left
      // an older probe current across every one of those exits.
      const requestSeq = getWindowCloseRequestSeq()
      if (!isQuitting) {
        const state = useAppStore.getState()
        const localPtyIds = Object.entries(state.tabsByWorktree).flatMap(
          ([worktreeId, worktreeTabs]) => {
            const connectionId = getConnectionId(worktreeId)
            if (connectionId !== null) {
              return []
            }
            return worktreeTabs
              .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
              .filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
          }
        )
        if (localPtyIds.length > 0) {
          // Why the same bound as the tab and pane close paths: an unanswered probe
          // must not leave the window silently stuck (#10142).
          void anyLocalPtyBlocksWindowClose(
            state.settings,
            localPtyIds,
            RUNNING_CLOSE_PROBE_TIMEOUT_MS
          ).then((blocked) => {
            if (requestSeq !== getWindowCloseRequestSeq()) {
              return
            }
            if (blocked) {
              setWindowCloseDialogOpen(true)
            } else {
              confirmNativeWindowClose()
            }
          })
          return
        }
      }
      confirmNativeWindowClose()
    },
    [confirmNativeWindowClose]
  )

  const windowCloseDialog = (
    <Dialog
      open={windowCloseDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          dismissWindowCloseDialog()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.Terminal.2fa9c69ff3', 'Close Window?')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.Terminal.7958465754',
              'There are local terminals with running processes. Close the window anyway?'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={dismissWindowCloseDialog}>
            {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => {
              dismissWindowCloseDialog()
              confirmNativeWindowClose()
            }}
          >
            {translate('auto.components.Terminal.73768427cf', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { proceedToNativeWindowClose, windowCloseDialog }
}
