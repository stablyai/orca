import { useCallback, useEffect, useState } from 'react'
import {
  isActiveWakePaneAttached,
  retryActiveWakePane
} from '@/components/terminal-pane/input/wake-pane-attach'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** How often the hold checks the pane in front while it waits. */
export const WAKE_ATTACH_POLL_MS = 100
/** A pane that hasn't re-attached by now gets the "Couldn't reconnect the terminal" card. */
export const WAKE_ATTACH_HOLD_MAX_MS = 8_000

type Track = {
  /** The last in-flight report of the current wake: what the pill showed before ready. */
  last: CloudWakeProgressEvent | undefined
  /** The wake shown as still connecting while the pane in front re-attaches. */
  held: CloudWakeProgressEvent | undefined
  /** Bumped per hold (a Try again starts a new one), so each gets its own clock. */
  attempt: number
  /** The pane never re-attached within the cap: shown as a failed card, not a dead pane. */
  stalled: CloudWakeProgressEvent | undefined
}

const IDLE: Track = { last: undefined, held: undefined, attempt: 0, stalled: undefined }

export type WakeAttachHold = {
  /** What the overlay shows in place of the store's wake, if anything. */
  wake: CloudWakeProgressEvent | undefined
  /** True when `wake` is the "Couldn't reconnect the terminal" failure. */
  terminalStalled: boolean
  /** Try again: reconnect the pane in front and wait for it once more. */
  retry: () => void
  dismiss: () => void
}

/**
 * A wake reports ready once the server answers; the pane in front re-attaches to its terminal a
 * moment later. Until it takes input (attached, with nothing it was given still unsent), this
 * returns the wake as still `connecting` (same start time and source, so the pill keeps counting
 * from the wake's start). A pane that hasn't by the cap becomes a failed card with Try again,
 * never a silent dead pane. Then `undefined` hands back to the store's wake.
 */
export function useWakeAttachHold(
  workspaceId: string,
  wake: CloudWakeProgressEvent | undefined,
  isAttached: (workspaceId: string) => boolean | null = isActiveWakePaneAttached,
  retryPane: (workspaceId: string) => boolean = retryActiveWakePane
): WakeAttachHold {
  const [track, setTrack] = useState<Track>(IDLE)

  // Adjusted during render (not in an effect), so the pill never shows a stale frame.
  if (wake && (wake.phase === 'waking' || wake.phase === 'connecting')) {
    const last = track.last
    if (
      !last ||
      last.startedAt !== wake.startedAt ||
      last.phase !== wake.phase ||
      track.held ||
      track.stalled
    ) {
      setTrack({ ...IDLE, attempt: track.attempt, last: wake })
    }
  } else if (wake?.phase === 'failed') {
    if (track.last || track.held || track.stalled) {
      setTrack({ ...IDLE, attempt: track.attempt })
    }
  } else if (track.last && (!wake || wake.startedAt === track.last.startedAt)) {
    // Ready, or the settled entry already dropped: hold only a wake that was in flight here.
    const held =
      isAttached(workspaceId) === false
        ? { ...track.last, phase: 'connecting' as const }
        : undefined
    setTrack({ ...IDLE, attempt: track.attempt + 1, held })
  }

  // Release once the pane takes input; at the cap, fail visibly. The store dropping the settled
  // wake doesn't cancel this: it is keyed on the hold only.
  const holding = track.held !== undefined
  const attempt = track.attempt
  useEffect(() => {
    if (!holding) {
      return
    }
    const since = Date.now()
    return installWindowVisibilityInterval({
      run: () => {
        const attached = isAttached(workspaceId)
        const timedOut = Date.now() - since >= WAKE_ATTACH_HOLD_MAX_MS
        if (attached === false && !timedOut) {
          return
        }
        setTrack((current) => {
          if (current.attempt !== attempt || !current.held) {
            return current
          }
          return attached === false
            ? {
                ...current,
                held: undefined,
                stalled: { ...current.held, phase: 'failed', at: Date.now() }
              }
            : { ...current, held: undefined }
        })
      },
      intervalMs: WAKE_ATTACH_POLL_MS
    })
  }, [holding, attempt, workspaceId, isAttached])

  const retry = useCallback(() => {
    retryPane(workspaceId)
    setTrack((current) =>
      current.stalled
        ? {
            ...current,
            attempt: current.attempt + 1,
            held: { ...current.stalled, phase: 'connecting' },
            stalled: undefined
          }
        : current
    )
  }, [workspaceId, retryPane])
  const dismiss = useCallback(
    () => setTrack((current) => (current.stalled ? { ...current, stalled: undefined } : current)),
    []
  )

  return {
    wake: track.stalled ?? track.held,
    terminalStalled: track.stalled !== undefined,
    retry,
    dismiss
  }
}
