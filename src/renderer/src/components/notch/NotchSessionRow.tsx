import { useEffect, useState } from 'react'
import { translate } from '../../i18n/i18n'
import { formatNotchElapsedSince } from '../../../../shared/notch/notch-duration-format'
import { SESSION_ROW_HEIGHT } from '../../../../shared/notch/notch-panel-rect'
import type { NotchRow } from '../../../../shared/notch/notch-snapshot'
import type { NotchLane } from '../../../../shared/notch/notch-status-summary'

const LANE_DOT: Record<NotchLane, string> = {
  working: 'bg-foreground',
  attention: 'bg-destructive',
  done: 'bg-status-success'
}

const LANE_STATE_FALLBACK: Record<NotchLane, string> = {
  working: 'Working',
  attention: 'Needs you',
  done: 'Finished'
}

function laneStateLabel(lane: NotchLane): string {
  return translate(`notch.rowState.${lane}`, LANE_STATE_FALLBACK[lane])
}

/** Ticks once a second only while a row is mounted; the panel is usually closed. */
function useElapsedLabel(stateStartedAt: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return formatNotchElapsedSince(stateStartedAt, now)
}

export function NotchSessionRow({
  row,
  onActivate
}: {
  row: NotchRow
  onActivate: (row: NotchRow) => void
}): React.JSX.Element {
  const elapsed = useElapsedLabel(row.stateStartedAt)
  // A row with no pane to route to still lists, but must not look actionable.
  const actionable = row.worktreeId !== null && row.tabId !== null

  return (
    <button
      type="button"
      disabled={!actionable}
      onClick={() => onActivate(row)}
      style={{ height: SESSION_ROW_HEIGHT }}
      className="flex w-full items-center gap-3 rounded-md px-3 text-left transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${LANE_DOT[row.lane]}`} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-tight text-foreground">
          {row.title}
        </span>
        <span className="truncate text-[11px] leading-tight text-muted-foreground">
          {[laneStateLabel(row.lane), row.agentType, row.subtitle].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{elapsed}</span>
    </button>
  )
}
