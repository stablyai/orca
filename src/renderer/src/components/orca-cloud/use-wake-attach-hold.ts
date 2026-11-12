import { useCallback, useEffect, useState } from 'react'
import {
  isActiveWakePaneAttached,
  retryActiveWakePane
} from '@/components/terminal-pane/input/wake-pane-attach'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** How often the hold checks the pane in front while it waits. */
export const WAKE_ATTACH_POLL_MS = 100
/** A pane that hasn't re-attached by now is reconnected once; after a second cap it gets the card. */
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
  /** Held by main's `ready` (not a Try again, which reconnects itself): reconnect the pane now. */
  reconnectNow: boolean
}

const IDLE: Track = {
  last: undefined,
  held: undefined,
  attempt: 0,
  stalled: undefined,
  reconnectNow: false
}

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
 * from the wake's start). A pane that hasn't by the cap is reconnected once quietly; one that
 * still hasn't by the next cap becomes a failed card with Try again (re-runs the attach), never a
 * silent dead pane, and the card clears itself if the pane attaches after all. Only main's `ready`
 * for a wake seen in flight arms this: a restart or an account restart with no wake never does.
 * Then `undefined` hands back to the store's wake.
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
  } else if (track.last) {
    // Only main's own `ready` for the wake seen in flight here holds the pane. An entry that just
    // goes away (a stale or quietly failed wake dropped by the store, a Dismiss) never does: no
    // wake brought the pane back, so there is nothing to wait for.
    const settled = wake?.phase === 'ready' && wake.startedAt === track.last.startedAt
    const held =
      settled && isAttached(workspaceId) === false
        ? { ...track.last, phase: 'connecting' as const }
        : undefined
    setTrack({ ...IDLE, attempt: track.attempt + 1, held, reconnectNow: held !== undefined })
  }

  // Release once the pane takes input; at the cap, reconnect it once quietly, then fail visibly.
  // The card keeps watching too: a pane that attaches later (restore, account restart, a slow
  // wake) clears it on its own. The store dropping the settled wake doesn't cancel this.
  const waiting = track.held !== undefined || track.stalled !== undefined
  const attempt = track.attempt
  const reconnectNow = track.reconnectNow
  useEffect(() => {
    if (!waiting) {
      return
    }
    // The server is up, so reconnect the pane in front now rather than waiting on its own path
    // back: a pane that sat through an app restart while asleep has none, and would otherwise only
    // come back at the cap. A pane already reconnecting ignores this (the reconnect only acts on a
    // pane that is idle or parked), and the quiet retry at the cap stays the safety net.
    if (reconnectNow && isAttached(workspaceId) === false) {
      retryPane(workspaceId)
    }
    // Only visible time counts toward the cap: a hidden window pauses this poll (and the pane's
    // own re-attach), so time spent hidden must not turn a healthy wake into a stalled card.
    let visibleMs = 0
    let lastAt = Date.now()
    let quietRetryDone = false
    let shownStalled = false
    const check = (): void => {
      const attached = isAttached(workspaceId)
      if (attached === false && (shownStalled || visibleMs < WAKE_ATTACH_HOLD_MAX_MS)) {
        return
      }
      if (attached === false && !quietRetryDone) {
        // One reconnect on its own before the card: a pane whose attach got lost usually comes
        // back from this, and the person never sees a failure for it.
        quietRetryDone = true
        visibleMs = 0
        retryPane(workspaceId)
        return
      }
      shownStalled = attached === false
      setTrack((current) => {
        if (current.attempt !== attempt || (!current.held && !current.stalled)) {
          return current
        }
        if (attached !== false) {
          return { ...current, held: undefined, stalled: undefined }
        }
        return current.held
          ? {
              ...current,
              held: undefined,
              stalled: { ...current.held, phase: 'failed', at: Date.now() }
            }
          : current
      })
    }
    return installWindowVisibilityInterval({
      run: () => {
        const now = Date.now()
        visibleMs += now - lastAt
        lastAt = now
        check()
      },
      // Back from hidden (and the first run): restart the clock without crediting the gap.
      runOnVisible: () => {
        lastAt = Date.now()
        check()
      },
      intervalMs: WAKE_ATTACH_POLL_MS
    })
  }, [waiting, attempt, reconnectNow, workspaceId, isAttached, retryPane])

  const retry = useCallback(() => {
    retryPane(workspaceId)
    setTrack((current) =>
      current.stalled
        ? {
            ...current,
            attempt: current.attempt + 1,
            held: { ...current.stalled, phase: 'connecting' },
            stalled: undefined,
            reconnectNow: false
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
