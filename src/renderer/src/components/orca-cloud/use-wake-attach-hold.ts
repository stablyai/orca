import { useEffect, useRef, useState } from 'react'
import { isActiveWakePaneAttached } from '@/components/terminal-pane/input/wake-pane-attach'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** How often the hold checks the pane in front while it waits. */
export const WAKE_ATTACH_POLL_MS = 100
/** A pane that never re-attaches (closed, broken) stops holding the pill after this. */
export const WAKE_ATTACH_HOLD_MAX_MS = 8_000

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
  const [held, setHeld] = useState<CloudWakeProgressEvent | undefined>(undefined)
  // The last in-flight phase of the current wake: what the pill showed before ready.
  const inFlight = useRef<CloudWakeProgressEvent | undefined>(undefined)

  useEffect(() => {
    if (wake && (wake.phase === 'waking' || wake.phase === 'connecting')) {
      inFlight.current = wake
      setHeld(undefined)
      return
    }
    if (wake?.phase === 'failed') {
      inFlight.current = undefined
      setHeld(undefined)
      return
    }
    // Ready, or the entry already dropped: hold only a wake that was in flight here.
    const last = inFlight.current
    inFlight.current = undefined
    if (!last || (wake && wake.startedAt !== last.startedAt)) {
      return
    }
    if (isAttached(workspaceId) !== false) {
      return
    }
    setHeld({ ...last, phase: 'connecting', at: Date.now() })
    // Keyed on the wake's identity and phase, not the object (the store re-creates it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, wake?.startedAt, wake?.phase, wake === undefined])

  // Its own effect: the store dropping the settled wake must not cancel the wait.
  const heldAt = held?.at
  useEffect(() => {
    if (heldAt === undefined) {
      return
    }
    const timer = setInterval(() => {
      if (isAttached(workspaceId) !== false || Date.now() - heldAt >= WAKE_ATTACH_HOLD_MAX_MS) {
        setHeld(undefined)
      }
    }, WAKE_ATTACH_POLL_MS)
    return () => clearInterval(timer)
  }, [heldAt, workspaceId, isAttached])

  return held
}
