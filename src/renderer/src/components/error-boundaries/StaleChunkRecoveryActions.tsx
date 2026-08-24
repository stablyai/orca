import { useEffect, useRef, useState, type ReactElement } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ORCA_APP_RESTART_ABORTED_EVENT } from '../../../../shared/updater-renderer-events'

// How long a clicked relaunch may leave this document alive before the fallback
// takes the buttons back. An Electron relaunch tears the window down ~150ms after
// the IPC resolves; a paired-web relaunch is an in-place reload that a broken
// document can swallow entirely, which would otherwise pin the button disabled.
export const RELAUNCH_SETTLE_GRACE_MS = 5_000

type Props = {
  /** Names the owning boundary on relaunch-failure logs. */
  boundaryId: string
  onRetry: () => void
}

/**
 * The stale-chunk recovery row shared by every lazy-chunk error boundary: a
 * broken document is not the place to recover itself, so the main-driven
 * "Restart Orca" leads and the in-place Retry stays as the lighter sibling for
 * the case where assets have already settled.
 *
 * Render only from an error boundary's fallback: catching an error rebuilds the
 * boundary's subtree, which is what keeps a stalled-restart notice from leaking
 * onto a later error's fallback (pinned by the boundaries' leak tests).
 */
export function StaleChunkRecoveryActions({ boundaryId, onRetry }: Props): ReactElement {
  const [relaunching, setRelaunching] = useState(false)
  const [relaunchStalled, setRelaunchStalled] = useState(false)
  // Sync double-click guard: the second click can reach the handler before the
  // disabled re-render commits, and a doubled app.relaunch() spawns two instances.
  const relaunchRequestedRef = useRef(false)
  const relaunchSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)

  useEffect(() => {
    // Re-arm after a StrictMode probe cleanup; real teardown must both stop a
    // pending invoke from scheduling and drop an already-armed settle timer.
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      if (relaunchSettleTimerRef.current !== null) {
        clearTimeout(relaunchSettleTimerRef.current)
        relaunchSettleTimerRef.current = null
      }
    }
  }, [])

  const markRelaunchStalled = (): void => {
    if (relaunchSettleTimerRef.current !== null) {
      clearTimeout(relaunchSettleTimerRef.current)
      relaunchSettleTimerRef.current = null
    }
    // The preload arms global unload/checkpoint bypasses before invoking main.
    // A surviving document must restore them before returning control to the user.
    window.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
    relaunchRequestedRef.current = false
    if (unmountedRef.current) {
      return
    }
    setRelaunching(false)
    setRelaunchStalled(true)
  }

  const handleRelaunchApp = (): void => {
    if (relaunchRequestedRef.current) {
      return
    }
    relaunchRequestedRef.current = true
    setRelaunching(true)
    setRelaunchStalled(false)
    void window.api.app.relaunch().then(
      () => {
        // Why: a resolved relaunch that leaves this document alive went nowhere
        // (swallowed in-place reload, teardown that never came); give the
        // buttons back with a notice instead of leaving a dead disabled control.
        // The grace must NOT start while the invoke is still pending — a slow
        // pre-relaunch checkpoint is normal, and re-arming the button mid-invoke
        // could double app.relaunch() into two replacement instances.
        if (!unmountedRef.current) {
          relaunchSettleTimerRef.current = setTimeout(markRelaunchStalled, RELAUNCH_SETTLE_GRACE_MS)
        }
      },
      (error: unknown) => {
        // Why: a refused pre-relaunch checkpoint keeps the app open; re-enable the button.
        console.error(`[${boundaryId}] app relaunch failed`, error)
        markRelaunchStalled()
      }
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={relaunching}
          onClick={handleRelaunchApp}
        >
          {translate(
            'auto.components.error.boundaries.RecoverableRenderErrorBoundary.restartOrca',
            'Restart Orca'
          )}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={relaunching}
          onClick={onRetry}
        >
          <RotateCw className="size-3.5" />
          {translate(
            'auto.components.error.boundaries.RecoverableRenderErrorBoundary.55001880db',
            'Retry'
          )}
        </Button>
      </div>
      {relaunchStalled ? (
        <div role="status" className="max-w-md text-xs">
          {translate(
            'auto.components.error.boundaries.RecoverableRenderErrorBoundary.restartStalled',
            "Restarting didn't complete. Try again, or retry this part of Orca."
          )}
        </div>
      ) : null}
    </>
  )
}
