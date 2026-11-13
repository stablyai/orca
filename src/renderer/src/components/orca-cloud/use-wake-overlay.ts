// The waking overlay's timing, shared by the owned and the PAIRED cloud surfaces.
import { useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import {
  WAKE_STALE_MS,
  isWakeActive,
  isWakeFailedFresh
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** A wake that settles faster than this never shows the overlay (no skeleton flash). */
const SHOW_DELAY_MS = 300
/** Once shown, the overlay stays at least this long so it never blinks. */
const MIN_HOLD_MS = 600
const FADE_MS = 200

/**
 * The wake the overlay shows: shown after SHOW_DELAY_MS, held at least MIN_HOLD_MS, faded out
 * after. A wake that stops reporting turns into a failure instead of quietly vanishing.
 */
export function useWakeOverlay(
  wake: CloudWakeProgressEvent | undefined,
  now: number,
  stalledMessage: string,
  /** Typing is already held for this wake: show its pill now, not after the show delay. */
  immediate = false
): { wake: CloudWakeProgressEvent | null; leaving: boolean } {
  const reducedMotion = usePrefersReducedMotion()
  const effective: CloudWakeProgressEvent | null = !wake
    ? null
    : isWakeActive(wake, now)
      ? wake
      : isWakeFailedFresh(wake, now)
        ? wake
        : (wake.phase === 'waking' || wake.phase === 'connecting') && now - wake.at >= WAKE_STALE_MS
          ? { ...wake, phase: 'failed', message: stalledMessage }
          : null
  const failed = effective?.phase === 'failed'
  const [shown, setShown] = useState<{ wake: CloudWakeProgressEvent; at: number } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const effectiveKey = effective ? `${effective.startedAt}:${effective.phase}` : null
  const latest = useRef(effective)
  latest.current = effective

  useEffect(() => {
    if (effective) {
      setLeaving(false)
      if (shown) {
        setShown({ wake: effective, at: shown.at })
        return undefined
      }
      // Failures show at once (and wakes the person is already typing into, and a wake that
      // started earlier, e.g. on hover, and has already outlasted the delay); others only if they
      // outlast the show delay.
      if (failed || immediate || Date.now() - effective.startedAt >= SHOW_DELAY_MS) {
        setShown({ wake: effective, at: Date.now() })
        return undefined
      }
      const timer = setTimeout(() => {
        if (latest.current) {
          setShown({ wake: latest.current, at: Date.now() })
        }
      }, SHOW_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (!shown) {
      return undefined
    }
    const hold = Math.max(0, shown.at + MIN_HOLD_MS - Date.now())
    const fade = reducedMotion ? 0 : FADE_MS
    const startFade = setTimeout(() => setLeaving(fade > 0), hold)
    const hide = setTimeout(() => {
      setLeaving(false)
      setShown(null)
    }, hold + fade)
    return () => {
      clearTimeout(startFade)
      clearTimeout(hide)
    }
    // `shown` is read, not tracked: a re-run per show would restart the hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKey, reducedMotion, immediate])

  return { wake: shown?.wake ?? null, leaving }
}
