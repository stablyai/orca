import type { RateLimitWindow } from '../../../../shared/rate-limit-types'
import { getRateLimitWindowPace } from '../../../../shared/rate-limit-window-pace'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'

/**
 * CodexBar-style pace tick: marks how far the current window has elapsed on a
 * usage bar. Green while consumption trails elapsed time, red once it runs
 * ahead. Parent must be `relative` and not clip overflow — the tick overhangs
 * the bar by 2px on each side so it stays visible over a same-colored fill.
 */
export function WindowPaceMarker({
  w,
  now,
  display,
  inverted = false
}: {
  w: RateLimitWindow
  now: number
  display: UsagePercentageDisplay
  inverted?: boolean
}): React.JSX.Element | null {
  const pace = getRateLimitWindowPace(w, now)
  if (!pace) {
    return null
  }
  // In "remaining" display the fill shows % left, so the tick marks time left.
  const positionPercent = display === 'remaining' ? 100 - pace.elapsedPercent : pace.elapsedPercent
  // Ring matches the surface behind the bar so the tick reads over any fill
  // color; non-inverted callers all render on popover surfaces.
  const ringClass = inverted ? 'ring-foreground' : 'ring-popover'
  return (
    <span
      aria-hidden
      data-pace={pace.overPace ? 'over' : 'on-track'}
      className={`absolute -inset-y-[2px] w-[2px] -translate-x-1/2 rounded-full ring-1 ${ringClass} ${
        pace.overPace ? 'bg-red-500' : 'bg-green-500'
      }`}
      style={{ left: `${positionPercent}%` }}
    />
  )
}
