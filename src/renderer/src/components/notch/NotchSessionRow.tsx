import { useEffect, useState } from 'react'
import { translate } from '../../i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { formatNotchElapsedSince } from '../../../../shared/notch/notch-duration-format'
import { SESSION_ROW_HEIGHT } from '../../../../shared/notch/notch-panel-rect'
import type { AgentType } from '../../../../shared/agent-status-types'
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

/** Ticks once a second only while a row is mounted; the panel is usually closed. */
function useElapsedLabel(stateStartedAt: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return formatNotchElapsedSince(stateStartedAt, now)
}

/**
 * One line: state dot, workspace, elapsed.
 *
 * Why no second line: the dot already carries the state, and the panel is a glance surface — a
 * `state · agent` subtitle doubled the row height to repeat what the dot said. Both still
 * reach screen readers through the row's accessible name.
 */
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
  const state = translate(`notch.rowState.${row.lane}`, LANE_STATE_FALLBACK[row.lane])

  return (
    <button
      type="button"
      disabled={!actionable}
      onClick={() => onActivate(row)}
      style={{ height: SESSION_ROW_HEIGHT }}
      aria-label={`${row.title} — ${state}${row.agentType ? ` — ${row.agentType}` : ''}`}
      className="flex w-full items-center gap-2.5 rounded px-2.5 text-left transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${LANE_DOT[row.lane]}`} />
      {/* Why the shared AgentIcon: it already resolves every provider Orca ships, so the notch
          and the sidebar can't disagree about what a Codex row looks like. Falls back to a
          neutral glyph when the agent identity has not arrived yet. */}
      <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
        <AgentIcon agent={agentTypeToIconAgent(row.agentType as AgentType | null)} size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] leading-none text-foreground">
        {row.title}
      </span>
      <span
        aria-hidden="true"
        className="shrink-0 text-[11px] leading-none tabular-nums text-muted-foreground"
      >
        {elapsed}
      </span>
    </button>
  )
}
