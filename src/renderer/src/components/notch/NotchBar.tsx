import { useEffect, useState } from 'react'
import { translate } from '../../i18n/i18n'
import type { NotchLane } from '../../../../shared/notch/notch-status-summary'
import type { NotchSnapshot } from '../../../../shared/notch/notch-snapshot'

// Moonglade's dot-matrix spinner; one frame per tick reads as motion without animating layout.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

function useSpinnerFrame(active: boolean): string {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    // Why: the reduced-motion contract is a steady glyph, not a slower one.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    const timer = setInterval(() => setIndex((value) => value + 1), SPINNER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active])
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length]
}

// Status is never carried by color alone — each lane has a distinct glyph too.
const LANE_CLASS: Record<NotchLane, string> = {
  working: 'text-foreground',
  attention: 'text-destructive',
  done: 'text-status-success'
}

// Why: every lane label is count-invariant on purpose. "{{count}} needs attention" reads as
// "2 needs attention" for any count above one, and this string is the only thing a screen
// reader gets for the lane — plural keys would work but the wording needn't need them.
const LANE_FALLBACK: Record<NotchLane, string> = {
  working: '{{count}} working',
  attention: '{{count}} awaiting input',
  done: '{{count}} finished'
}

function laneLabel(lane: NotchLane, count: number): string {
  return translate(`notch.status.${lane}`, LANE_FALLBACK[lane], { count })
}

function LaneIndicator({
  lane,
  count,
  spinnerFrame
}: {
  lane: NotchLane
  count: number
  spinnerFrame: string
}): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-1 tabular-nums ${LANE_CLASS[lane]}`}
      role="status"
      aria-label={laneLabel(lane, count)}
    >
      <span aria-hidden="true" className="text-[11px] leading-none">
        {lane === 'working' ? spinnerFrame : '●'}
      </span>
      <span aria-hidden="true" className="text-[11px] font-medium leading-none">
        {count}
      </span>
    </div>
  )
}

function Wing({
  lanes,
  counts,
  width,
  spinnerFrame,
  showsIdleMark
}: {
  lanes: NotchLane[]
  counts: Record<NotchLane, number>
  width: number
  spinnerFrame: string
  showsIdleMark: boolean
}): React.JSX.Element {
  return (
    <div
      className="flex h-full shrink-0 items-center justify-center gap-1.5"
      style={{ width }}
      data-testid="notch-wing"
    >
      {showsIdleMark ? (
        <span
          className="text-[11px] leading-none text-muted-foreground/60"
          role="status"
          aria-label={translate('notch.status.idle', 'No agents running')}
        >
          ◗
        </span>
      ) : (
        lanes.map((lane) => (
          <LaneIndicator key={lane} lane={lane} count={counts[lane]} spinnerFrame={spinnerFrame} />
        ))
      )}
    </div>
  )
}

/** Just the bar. The panel around it owns page-level layout and the expansion behavior. */
export function NotchBar({
  snapshot,
  squareBottom
}: {
  snapshot: NotchSnapshot
  /** Open, the bar's bottom edge meets the card, so it must not round away from it. */
  squareBottom: boolean
}): React.JSX.Element {
  const { layout, metrics, counts } = snapshot
  const spinnerFrame = useSpinnerFrame(counts.working > 0)
  const isNotch = metrics.presentation === 'notch'
  const bottomRadius = squareBottom ? 0 : metrics.bottomCornerRadius

  return (
    <div
      className="flex shrink-0 items-center bg-black text-white"
      style={{
        width: layout.barWidth,
        height: metrics.barHeight,
        // The hardware notch flares into the screen edge; the pill is a detached capsule.
        borderBottomLeftRadius: bottomRadius,
        borderBottomRightRadius: bottomRadius,
        borderTopLeftRadius: isNotch ? 0 : metrics.bottomCornerRadius,
        borderTopRightRadius: isNotch ? 0 : metrics.bottomCornerRadius
      }}
    >
      <Wing
        lanes={layout.leftLanes}
        counts={counts}
        width={layout.wings.left}
        spinnerFrame={spinnerFrame}
        showsIdleMark={layout.showsIdleMark}
      />
      {/* The camera cutout: painted, never occupied. */}
      <div className="h-full shrink-0" style={{ width: metrics.notchWidth }} aria-hidden="true" />
      <Wing
        lanes={layout.rightLanes}
        counts={counts}
        width={layout.wings.right}
        spinnerFrame={spinnerFrame}
        showsIdleMark={false}
      />
    </div>
  )
}
