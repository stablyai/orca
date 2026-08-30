import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import {
  abandonWindowCloseRequest,
  getWindowCloseRequestSeq,
  runWithWindowCloseCheckpointScope
} from '../window-close-request-coordinator'
import { anyPtyBlocksWindowClose } from './window-close-running-process-evidence'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'

/**
 * How long the probe may run before the window admits it is working.
 *
 * Why a delay and not an immediate dialog: the probe answers in ~0.1 ms warm and ~180 ms cold, and
 * a dialog that flashes for either reads as a glitch (STYLEGUIDE UX rule 1 — defer visible loading
 * feedback so local users see nothing and only a genuinely slow host earns the affordance). Why not
 * the ~200 ms floor that rule names: a cold process-table scan measures ~194 ms p95, so 200 ms would
 * flash on ordinary local closes. Anything past this is a host taking long enough to notice.
 */
export const WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS = 500

/** `checking` is the probe in flight; `blocked` is the probe's answer. */
type WindowCloseDialogPhase = 'idle' | 'checking' | 'blocked'

export type WindowCloseRunningProcessPrompt = {
  /** Probes the window's PTYs on their execution hosts, then raises the confirmation or closes. */
  proceedToNativeWindowClose: (isQuitting: boolean) => void
  windowCloseDialog: ReactElement
}

/**
 * The window-close confirmation, shown for any terminal with running children.
 * Direct-SSH panes are probed on their execution host rather than skipped: their
 * shell does not survive the window, so treating "runs elsewhere" as "not ours to
 * warn about" closed over live remote work. Owns the probe, the decision and the
 * dialog together so the decision is only ever reachable through the surface the
 * user actually sees.
 *
 * A host that never answers spends the whole probe deadline, so the same dialog also
 * carries the wait: it opens in `checking` once the probe outruns the delay above, and
 * the prompt replaces that line in place. Without it the window sat for four silent
 * seconds and read as frozen.
 */
export function useWindowCloseRunningProcessPrompt(): WindowCloseRunningProcessPrompt {
  const [dialogPhase, setDialogPhase] = useState<WindowCloseDialogPhase>('idle')
  const checkingAffordanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  const cancelCheckingAffordance = useCallback(() => {
    if (checkingAffordanceTimerRef.current !== null) {
      clearTimeout(checkingAffordanceTimerRef.current)
      checkingAffordanceTimerRef.current = null
    }
  }, [])

  // Why: a probe outliving the component would otherwise leave its timer armed.
  useEffect(() => cancelCheckingAffordance, [cancelCheckingAffordance])

  // Why focus here and not `autoFocus`: the button mounts disabled on the slow path, so
  // the attribute fires against a control that cannot take focus and the affirmative
  // action would keep the focus the fast path gives it. Focus arrives with the question.
  useEffect(() => {
    if (dialogPhase === 'blocked') {
      confirmButtonRef.current?.focus()
    }
  }, [dialogPhase])

  /** Ends the current attempt. Why abandon and not just close the dialog: the newest
   *  attempt is not the newest intent — a probe still outstanding when the user
   *  dismisses belongs to a close they have since called off, and letting it
   *  decide closes the window they just chose to keep. */
  const dismissWindowCloseDialog = useCallback(() => {
    abandonWindowCloseRequest()
    cancelCheckingAffordance()
    setDialogPhase('idle')
  }, [cancelCheckingAffordance])

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
      // Why here too: a superseded attempt's timer would otherwise raise `checking`
      // for a request that has already been answered, including on the paths below
      // that never probe at all.
      cancelCheckingAffordance()
      if (!isQuitting) {
        const state = useAppStore.getState()
        // Why no owning-host filter: `inspectProcess` dispatches on the PTY id, so
        // each pane is answered by whichever host runs it. Selecting local worktrees
        // here discarded every direct-SSH pane unprobed, and discarded a worktree
        // whose repo had not hydrated yet as though it were remote.
        const ptyIds = Object.values(state.tabsByWorktree).flatMap((worktreeTabs) =>
          worktreeTabs
            .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
            // Runtime-environment panes stay out: they are owned by a host this
            // window is only a viewer of, and outlive it by design.
            .filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
        )
        if (ptyIds.length > 0) {
          checkingAffordanceTimerRef.current = setTimeout(() => {
            checkingAffordanceTimerRef.current = null
            // Why the same fence as the answer: the requests that never reach this
            // function cannot cancel this timer, so without it a deferred or vetoed
            // close raises `checking` for an attempt already superseded.
            if (requestSeq !== getWindowCloseRequestSeq()) {
              return
            }
            setDialogPhase('checking')
          }, WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)
          // Why the same bound as the tab and pane close paths: an unanswered probe
          // must not leave the window silently stuck (#10142).
          void anyPtyBlocksWindowClose(state.settings, ptyIds, RUNNING_CLOSE_PROBE_TIMEOUT_MS).then(
            (blocked) => {
              if (requestSeq !== getWindowCloseRequestSeq()) {
                return
              }
              cancelCheckingAffordance()
              if (blocked) {
                setDialogPhase('blocked')
              } else {
                setDialogPhase('idle')
                confirmNativeWindowClose()
              }
            }
          )
          return
        }
      }
      confirmNativeWindowClose()
    },
    [cancelCheckingAffordance, confirmNativeWindowClose]
  )

  const isChecking = dialogPhase === 'checking'
  const windowCloseDialog = (
    <Dialog
      open={dialogPhase !== 'idle'}
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
          {/* Why both lines in one grid cell: the box is then sized for the taller of the
              two in either phase, so the prompt replacing the checking line cannot resize
              the dialog under the pointer (STYLEGUIDE UX rule 1 — pre-reserve the space).
              `invisible` keeps the inactive line out of the accessibility tree. */}
          <DialogDescription className="grid text-xs">
            <span
              className={cn(
                'col-start-1 row-start-1 flex items-center gap-1.5',
                !isChecking && 'invisible'
              )}
            >
              <Loader2 className="size-4 shrink-0 animate-spin" />
              {translate(
                'auto.components.Terminal.4d1f0a86c7',
                'Checking terminals for running processes…'
              )}
            </span>
            <span className={cn('col-start-1 row-start-1', isChecking && 'invisible')}>
              {translate(
                'auto.components.Terminal.7958465754',
                'There are terminals with running processes. Close the window anyway?'
              )}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={dismissWindowCloseDialog}>
            {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
          </Button>
          {/* Why disabled rather than hidden: the footer keeps one shape across both
              phases, so nothing in the dialog moves when the answer lands. */}
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="destructive"
            size="sm"
            // Why both this and the effect above: Radix's focus scope re-runs on open and
            // takes the focus back from a mount-time effect, so the fast path needs the
            // attribute; the slow path mounts this disabled, where the attribute is a
            // no-op, so the transition needs the effect. Neither covers the other's case.
            autoFocus
            disabled={isChecking}
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
