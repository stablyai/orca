import { useEffect, useState } from 'react'
import { isActiveWakePaneAttached } from '@/components/terminal-pane/input/wake-pane-attach'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** How often the hold checks the pane in front while it waits. */
export const WAKE_ATTACH_POLL_MS = 100
/** A pane that never re-attaches (closed, broken) stops holding the pill after this. */
export const WAKE_ATTACH_HOLD_MAX_MS = 8_000

type Track = {
  /** The last in-flight report of the current wake: what the pill showed before ready. */
  last: CloudWakeProgressEvent | undefined
  /** The wake shown as still connecting while the pane in front re-attaches. */
  held: CloudWakeProgressEvent | undefined
}

/**
 * A wake reports ready once the server answers; the pane in front re-attaches to its terminal a
 * moment later. Until it has, this returns the wake as still `connecting` (same start time and
 * source, so the pill keeps counting from the wake's start), then `undefined` hands back to the
 * store's wake. Bounded, so a pane that never attaches can't hold the pill forever.
 */
export function useWakeAttachHold(
  workspaceId: string,
  wake: CloudWakeProgressEvent | undefined,
  isAttached: (workspaceId: string) => boolean | null = isActiveWakePaneAttached
): CloudWakeProgressEvent | undefined {
  const [track, setTrack] = useState<Track>({ last: undefined, held: undefined })

  // Adjusted during render (not in an effect), so the pill never shows a stale frame.
  if (wake && (wake.phase === 'waking' || wake.phase === 'connecting')) {
    const last = track.last
    if (!last || last.startedAt !== wake.startedAt || last.phase !== wake.phase || track.held) {
      setTrack({ last: wake, held: undefined })
    }
  } else if (wake?.phase === 'failed') {
    if (track.last || track.held) {
      setTrack({ last: undefined, held: undefined })
    }
  } else if (track.last && (!wake || wake.startedAt === track.last.startedAt)) {
    // Ready, or the settled entry already dropped: hold only a wake that was in flight here.
    const held =
      isAttached(workspaceId) === false
        ? { ...track.last, phase: 'connecting' as const }
        : undefined
    setTrack({ last: undefined, held })
  }

  // Release once the pane is attached, or after the cap. The store dropping the settled wake
  // doesn't cancel this: it is keyed on the held wake only.
  const heldStart = track.held?.startedAt
  useEffect(() => {
    if (heldStart === undefined) {
      return
    }
    const since = Date.now()
    return installWindowVisibilityInterval({
      run: () => {
        if (isAttached(workspaceId) !== false || Date.now() - since >= WAKE_ATTACH_HOLD_MAX_MS) {
          setTrack((current) =>
            current.held?.startedAt === heldStart ? { ...current, held: undefined } : current
          )
        }
      },
      intervalMs: WAKE_ATTACH_POLL_MS
    })
  }, [heldStart, workspaceId, isAttached])

  return track.held
}
